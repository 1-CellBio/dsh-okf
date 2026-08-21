import { compileExtract, coveredCompileStages, type CompileOptions, type CompileResult, type CompileStage, ALL_COMPILE_STAGES } from "@/lib/compile/run";
import { COMPILE_SCHEMA_VERSION } from "@/lib/compile/prompt";
import { loadAlignVocabulary } from "@/lib/compile/align";
import { extractTextHash } from "@/lib/compile/deadLinks";
import { backfillExtractBindings, resourcesFromFrontmatter } from "@/lib/extractors/bind";
import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { TrackingStore } from "@/lib/fs/trackingStore";
import { asString, paperConceptId, paperSlug } from "@/lib/okf/identity";
import { conceptPath } from "@/lib/okf/links";
import { parseDocument } from "@/lib/okf/parse";
import { conceptSlug } from "@/lib/okf/slug";
import { mapPool, parseConcurrency } from "@/lib/pipeline/pool";
import { loadState } from "@/lib/pipeline/state";
import type { ChatClient } from "@/lib/providers/types";

export type CompileTarget = {
  extractPath: string;
  extractText: string;
  title: string;
  paperPath?: string;
  pdfFilename: string;
  pdfStorePath: string;
};

export async function listCompileTargets(store: FileStore, paperPath?: string): Promise<CompileTarget[]> {
  const selector = paperPath?.trim();
  if (selector) {
    await backfillExtractBindings(store);
  }
  const targets = await loadExtractTargets(store);
  if (!selector) {
    return targets;
  }
  const matched = await resolveCompileTargets(store, targets, selector);
  if (matched.length === 0) {
    throw new Error(missingExtractMessage(selector, targets));
  }
  return matched;
}

export type CompileBatchResult = {
  results: CompileResult[];
  failures: Array<{ path: string; message: string }>;
};

export async function compileTargets(
  store: FileStore,
  client: ChatClient,
  options: CompileOptions,
  paperPath?: string,
  concurrency?: number,
): Promise<CompileBatchResult> {
  const targets = await listCompileTargets(store, paperPath);
  options.onLog?.(
    targets.length === 0
      ? "compile targets=0 (extracts/*.md listing empty)"
      : `compile targets=${targets.length}${paperPath ? ` selector=${paperPath}` : ""}`,
  );
  const limit = paperPath ? 1 : parseConcurrency(concurrency == null ? undefined : String(concurrency), 3);
  // Load the alignment vocabulary once for the whole batch instead of once per
  // extract. Each compileExtract previously re-read every topics/methods/
  // entities page, making the full-library read O(extracts x concepts).
  const vocab = await loadAlignVocabulary(store);
  const failures: Array<{ path: string; message: string }> = [];
  // A paper selector is an explicit recompile request; only the selector-less
  // batch run skips extracts already compiled with the current schema.
  const skipCompiled = !paperPath;
  const requiredStages = new Set<CompileStage>(options.stages?.length ? options.stages : ALL_COMPILE_STAGES);
  const results = await mapPool(targets, limit, async (target) => {
    if (skipCompiled && (await alreadyCompiled(store, target, requiredStages))) {
      return { paperPath: target.paperPath!, written: [], skippedVerified: [], alreadyCompiled: true };
    }
    const tracking = new TrackingStore(store);
    try {
      return await compileExtract(
        tracking,
        client,
        {
          extractText: target.extractText,
          extractPath: target.extractPath,
          pdfFilename: target.pdfFilename,
          pdfStorePath: target.pdfStorePath,
        },
        { ...options, paperPath: target.paperPath ?? options.paperPath, alignVocabulary: vocab },
      );
    } catch (error) {
      // Roll back this target's writes atomically (like ingest does) so a
      // failed compile can't leave concepts/claims without their paper. The
      // rebuildable .okf/ compile cache survives rollback for resume.
      await tracking.rollback();
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ path: target.extractPath, message });
      return undefined;
    }
  });
  const succeeded = results.filter((result): result is CompileResult => result !== undefined);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`compile failed: ${failure.path}: ${failure.message}`);
    }
    if (succeeded.length === 0) {
      throw new Error(`all ${targets.length} extract(s) failed to compile`);
    }
  }
  return { results: succeeded, failures };
}

async function loadExtractTargets(store: FileStore): Promise<CompileTarget[]> {
  const targets: CompileTarget[] = [];
  for (const path of (await store.list("extracts/")).filter((item) => item.endsWith(".md"))) {
    const doc = parseDocument(utf8Decode(await store.read(path)));
    const paper = asString(doc.frontmatter.paper);
    const stem = path.replace(/^extracts\//, "").replace(/\.md$/i, "");
    // Source file comes from the extract's own frontmatter resource
    // (sources/pdfs/*.pdf or sources/docs/*.docx/…), with a PDF default for
    // legacy extracts that predate the resource field.
    const pdfStorePath = (
      asString(doc.frontmatter.resource) ?? `sources/pdfs/${stem}.pdf`
    ).replace(/^\/+/, "");
    targets.push({
      extractPath: path,
      extractText: doc.body,
      title: asString(doc.frontmatter.title) ?? stem,
      paperPath: paper ? conceptPath(paper) : undefined,
      pdfFilename: pdfStorePath.split("/").pop() ?? pdfStorePath,
      pdfStorePath,
    });
  }
  return targets;
}

async function resolveCompileTargets(
  store: FileStore,
  targets: CompileTarget[],
  selector: string,
): Promise<CompileTarget[]> {
  const raw = selector.replace(/^\/+/, "");

  const extractHit = matchExtractPath(targets, raw);
  if (extractHit) {
    return [extractHit];
  }

  const pdfHit = matchSourceSelector(targets, raw);
  if (pdfHit) {
    return [pdfHit];
  }

  const want = paperConceptId(raw.startsWith("papers/") ? raw : `papers/${raw}`);
  const bound = targets.filter((target) => target.paperPath && paperConceptId(target.paperPath) === want);
  if (bound.length > 0) {
    return bound;
  }

  const fromState = await matchPipelinePaper(store, targets, want);
  if (fromState) {
    return [withPaperPath(fromState, want)];
  }

  const paperFile = conceptPath(want);
  if (await store.exists(paperFile)) {
    const paper = parseDocument(utf8Decode(await store.read(paperFile)));
    const resources = new Set(resourcesFromFrontmatter(paper.frontmatter));
    const byResource = targets.filter((target) => resources.has(target.pdfStorePath));
    if (byResource.length > 0) {
      return byResource.map((target) => withPaperPath(target, want));
    }
    const titleSlug = conceptSlug(asString(paper.frontmatter.title) ?? "");
    const byTitle = targets.filter((target) => slugRelated(conceptSlug(target.title), titleSlug));
    if (byTitle.length === 1) {
      return [withPaperPath(byTitle[0]!, want)];
    }
  }

  const slug = paperSlug(want);
  const fuzzy = targets.filter(
    (target) =>
      slugRelated(conceptSlug(target.title), slug) ||
      slugRelated(conceptSlug(target.pdfFilename.replace(/\.[^./]+$/u, "")), slug),
  );
  if (fuzzy.length === 1) {
    const hit = fuzzy[0]!;
    return (await store.exists(paperFile)) ? [withPaperPath(hit, want)] : [hit];
  }
  return [];
}

function withPaperPath(target: CompileTarget, want: string): CompileTarget {
  return target.paperPath ? target : { ...target, paperPath: conceptPath(want) };
}

function matchExtractPath(targets: CompileTarget[], raw: string): CompileTarget | undefined {
  const candidates = [
    raw.endsWith(".md") ? raw : `${raw}.md`,
    raw.startsWith("extracts/") ? raw : `extracts/${raw.endsWith(".md") ? raw : `${raw}.md`}`,
  ];
  const keys = new Set(candidates.map((item) => item.replace(/^\/+/, "")));
  return targets.find((target) => keys.has(target.extractPath));
}

function matchSourceSelector(targets: CompileTarget[], raw: string): CompileTarget | undefined {
  if (raw.startsWith("sources/")) {
    const storePath = raw.replace(/^\/+/, "");
    const hit = targets.find((target) => target.pdfStorePath === storePath);
    if (hit) {
      return hit;
    }
  }
  const base = raw.split("/").pop() ?? raw;
  if (!base.includes(".")) {
    return undefined; // not a source filename — fall through to paper matching
  }
  const normalized = base.toLowerCase();
  return targets.find(
    (target) =>
      target.pdfFilename.toLowerCase() === normalized ||
      (target.pdfStorePath.split("/").pop() ?? "").toLowerCase() === normalized,
  );
}

async function matchPipelinePaper(
  store: FileStore,
  targets: CompileTarget[],
  want: string,
): Promise<CompileTarget | undefined> {
  const state = await loadState(store);
  for (const record of Object.values(state.pdfs)) {
    if (!record.paper || !record.extract) {
      continue;
    }
    if (paperConceptId(record.paper) !== want) {
      continue;
    }
    const extractPath = record.extract.replace(/^\/+/, "");
    return targets.find((target) => target.extractPath === extractPath);
  }
  return undefined;
}

function slugRelated(left: string, right: string): boolean {
  const a = stripYearPrefix(left);
  const b = stripYearPrefix(right);
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  const n = Math.min(a.length, b.length);
  if (n < 12) {
    return a.includes(b) || b.includes(a);
  }
  return a.startsWith(b) || b.startsWith(a);
}

function stripYearPrefix(slug: string): string {
  return slug.replace(/^\d{4}-/, "");
}

/**
 * True when the target's paper was already compiled from this exact extract
 * text under the current schema version AND with every stage this run asks
 * for, so a batch compile can skip the full LLM pass. Targeted compiles
 * (paper selector) never consult this — they are explicit recompile requests.
 */
async function alreadyCompiled(
  store: FileStore,
  target: CompileTarget,
  requiredStages: Set<CompileStage>,
): Promise<boolean> {
  if (!target.paperPath || !(await store.exists(target.paperPath))) {
    return false;
  }
  try {
    const paper = parseDocument(utf8Decode(await store.read(target.paperPath)));
    if (paper.frontmatter.compileVersion !== COMPILE_SCHEMA_VERSION) {
      return false;
    }
    if (paper.frontmatter.extractHash !== extractTextHash(target.extractText)) {
      return false;
    }
    const covered = coveredCompileStages(paper.frontmatter);
    for (const stage of requiredStages) {
      if (!covered.has(stage)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function missingExtractMessage(selector: string, targets: CompileTarget[]): string {
  if (targets.length === 0) {
    return (
      `No extract bound to ${selector}: extracts/*.md listing is empty. ` +
      `Ingest writes those files; okf_stats TextExtract count uses a full-tree list, ` +
      `so a non-zero census with this error was a prefix-list bug (fixed). Retry okf_compile.`
    );
  }
  const unbound = targets.filter((target) => !target.paperPath).slice(0, 8);
  const listed = unbound
    .map((target) => `${target.extractPath} (PDF ${target.pdfFilename})`)
    .join("; ");
  const hint = listed
    ? ` Unbound extracts are named after the PDF until compile writes paper:: ${listed}.`
    : " Pass extracts/<stem>.md, papers/<id>, or the source filename (foo.pdf).";
  return (
    `No extract bound to ${selector}. Pass extracts/*.md, a PDF stem, or omit paper to compile every extract.` +
    hint
  );
}
