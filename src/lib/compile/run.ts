import { applyBiblio } from "@/lib/biblio/apply";
import type { BiblioClient, BiblioFrontmatter } from "@/lib/biblio/types";
import {
  AlignIndex,
  formatVocabularyForPrompt,
  loadAlignVocabulary,
  normalizeAlignKey,
  type AlignEntry,
} from "@/lib/compile/align";
import { parentheticals } from "@/lib/compile/hubMatch";
import { bindExtractToPaper } from "@/lib/extractors/bind";
import { withPathLock } from "@/lib/fs/pathLock";
import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { generatedBy } from "@/lib/okf/generated";
import { asString, asTags, unionTags } from "@/lib/okf/identity";
import { parseDocument } from "@/lib/okf/parse";
import { serializeDocument } from "@/lib/okf/serialize";
import { conceptSlug, normalizePublished, publishedYear, slugify } from "@/lib/okf/slug";
import { isHumanVerified } from "@/lib/okf/validate";
import type { ChatClient } from "@/lib/providers/types";
import { mapPool } from "@/lib/pipeline/pool";
import { ensureLink, mergePaperLinks, rewriteBundleHref } from "./mergeLinks";
import { parseClaimsOnly, parseCompileOutput, parseSegmentOutput } from "./parseOutput";
import { applyHubMergesToBody, consolidateHubs } from "./consolidate";
import { aliasAlignIncoming } from "./aliasPass";
import { knownTitlesOf, mergeCompileOutput } from "./mergeOutput";
import {
  clearCompileOutput,
  DeadLinkError,
  extractTextHash,
  guardCompileLinks,
  loadCompileOutput,
  sanitizeBodyLinks,
  saveCompileOutput,
} from "./deadLinks";
import {
  COMPILE_SCHEMA_VERSION,
  compileSegmentSystemPrompt,
  compileSegmentUserPrompt,
  compileSystemPrompt,
  compileUserPrompt,
  EXTRACT_CHAR_LIMIT,
  repairUserPrompt,
  SEGMENT_COMPILE_CONCURRENCY,
} from "./prompt";
import { CLAIMS_SYSTEM_PROMPT, claimsUserPrompt } from "./promptClaims";
import { segmentExtract, writeClaims } from "./claims";
import type { CompileClaim, CompileConcept, CompileOutput, CompileSegmentOutput } from "./types";

export type CompileInput = {
  extractText: string;
  extractPath?: string;
  pdfFilename: string;
  pdfStorePath: string;
  pdfTitle?: string;
  pdfAuthor?: string;
  pdfCreationDate?: string;
};

export type CompileStage = "biblio" | "concepts" | "claims" | "digest" | "genes" | "pathways";

/** Stages that run when the caller does not specify any. Genes/pathways are
 * opt-in: they cost extra LLM tokens and most libraries do not want them, so
 * the user must ask (e.g. stages=["biblio","concepts","claims","digest","genes","pathways"]). */
export const ALL_COMPILE_STAGES: CompileStage[] = ["biblio", "concepts", "claims", "digest"];

/** Extra stages accepted on top of the default set. */
export const OPTIONAL_COMPILE_STAGES: CompileStage[] = ["genes", "pathways"];

function isCompileStage(value: unknown): value is CompileStage {
  return (
    value === "biblio" || value === "concepts" || value === "claims" || value === "digest" ||
    value === "genes" || value === "pathways"
  );
}

/** Parse a frontmatter compileStages value; undefined when the field is absent. */
export function compileStagesOf(value: unknown): Set<CompileStage> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const stages = new Set<CompileStage>();
  for (const item of value) {
    if (isCompileStage(item)) {
      stages.add(item);
    }
  }
  return stages;
}

/** Stages a paper's frontmatter says it has been compiled with. A missing
 * compileStages field on a current-version paper means the pre-stamping era,
 * when compiles always used the full prompt (incl. genes/pathways) — treat it
 * as covering everything so those papers are not needlessly recompiled. */
export function coveredCompileStages(frontmatter: { compileVersion?: unknown; compileStages?: unknown }): Set<CompileStage> {
  const recorded = compileStagesOf(frontmatter.compileStages);
  if (recorded) {
    return recorded;
  }
  return frontmatter.compileVersion === COMPILE_SCHEMA_VERSION
    ? new Set<CompileStage>([...ALL_COMPILE_STAGES, ...OPTIONAL_COMPILE_STAGES])
    : new Set<CompileStage>();
}

export type CompileOptions = {
  model: string;
  now?: string;
  stages?: CompileStage[];
  paperPath?: string;
  biblio?: BiblioClient;
  /** Preloaded alignment vocabulary shared across a batch. When omitted,
   * compileExtract loads it once per call (the costly full-library read). */
  alignVocabulary?: AlignIndex;
  /** When a previous compile of this extract left a persisted LLM output in
   * the rebuildable cache, reuse it so a retry resumes from the write/link-guard
   * phase instead of re-running the model. Default true. */
  resumeCompile?: boolean;
  /** Progress lines (ingest / compile job_output). */
  onLog?: (line: string) => void;
};

function selectedStages(options: CompileOptions): Set<CompileStage> {
  const list = options.stages?.length ? options.stages : ALL_COMPILE_STAGES;
  return new Set(list);
}

export type CompileResult = {
  paperPath: string;
  written: string[];
  skippedVerified: string[];
  /** Set when the batch skipped this target because it was already compiled
   * with the current schema version and unchanged extract text. */
  alreadyCompiled?: boolean;
};

function yearFromFilename(filename: string): string | undefined {
  const match = filename.match(/(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/);
  return match?.[1];
}

function yearFromPdfDate(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(/(19|20)\d{2}/);
  return match?.[0];
}

export function resolvePublished(
  fromModel: string | undefined,
  filename: string,
  pdfCreationDate?: string,
): string | undefined {
  // Prefer a normalized model date; if the model supplied an invalid one, fall
  // through to filename/PDF hints instead of persisting a bogus date.
  if (fromModel) {
    const normalized = normalizePublished(fromModel);
    if (normalized) {
      return normalized;
    }
  }
  const fromName = yearFromFilename(filename);
  if (fromName) {
    return normalizePublished(fromName);
  }
  const fromPdf = yearFromPdfDate(pdfCreationDate);
  return fromPdf ? normalizePublished(fromPdf) : undefined;
}

function unionAliases(existing: unknown, canonicalTitle: string, incomingTitle: string): string[] {
  const extra =
    incomingTitle.trim() &&
    normalizeAlignKey(incomingTitle) !== normalizeAlignKey(canonicalTitle)
      ? [incomingTitle.trim()]
      : [];
  const skip = normalizeAlignKey(canonicalTitle);
  const parens = [...parentheticals(canonicalTitle), ...parentheticals(incomingTitle)].filter(
    (alias) => normalizeAlignKey(alias) !== skip,
  );
  return [...new Set([...asTags(existing), ...extra, ...parens])];
}

async function upsertPaper(
  store: FileStore,
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<"written" | "skipped"> {
  return withPathLock(path, async () => {
    if (await store.exists(path)) {
      const existing = parseDocument(utf8Decode(await store.read(path)));
      if (isHumanVerified(existing.frontmatter)) {
        return "skipped";
      }
    }
    await store.write(path, serializeDocument(frontmatter, body));
    return "written";
  });
}

async function upsertRelated(
  store: FileStore,
  path: string,
  incoming: {
    type: string;
    title: string;
    incomingTitle: string;
    tags?: string[];
    generated: { by: string; at: string };
    body: string;
    paperTitle: string;
    paperHref: string;
  },
): Promise<"written" | "skipped"> {
  return withPathLock(path, async () => {
    if (await store.exists(path)) {
      const existing = parseDocument(utf8Decode(await store.read(path)));
      const aliases = unionAliases(
        existing.frontmatter.aliases,
        asString(existing.frontmatter.title) ?? incoming.title,
        incoming.incomingTitle,
      );
      if (isHumanVerified(existing.frontmatter)) {
        const nextBody = ensureLink(existing.body, incoming.paperTitle, incoming.paperHref);
        const nextFrontmatter = {
          ...existing.frontmatter,
          ...(aliases.length > 0 ? { aliases } : {}),
        };
        if (
          nextBody !== existing.body ||
          JSON.stringify(nextFrontmatter) !== JSON.stringify(existing.frontmatter)
        ) {
          await store.write(path, serializeDocument(nextFrontmatter, nextBody));
        }
        return "skipped";
      }
      const nextBody = mergePaperLinks(
        existing.body,
        ensureLink(incoming.body, incoming.paperTitle, incoming.paperHref),
      );
      await store.write(
        path,
        serializeDocument(
          {
            ...existing.frontmatter,
            type: incoming.type,
            title: asString(existing.frontmatter.title) ?? incoming.title,
            tags: unionTags(existing.frontmatter.tags, incoming.tags),
            generated: incoming.generated,
            ...(aliases.length > 0 ? { aliases } : {}),
          },
          nextBody,
        ),
      );
      return "written";
    }
    const aliases = unionAliases([], incoming.title, incoming.incomingTitle);
    await store.write(
      path,
      serializeDocument(
        {
          type: incoming.type,
          title: incoming.title,
          tags: incoming.tags ?? [],
          generated: incoming.generated,
          ...(aliases.length > 0 ? { aliases } : {}),
        },
        ensureLink(incoming.body, incoming.paperTitle, incoming.paperHref),
      ),
    );
    return "written";
  });
}

async function writeRelated(
  store: FileStore,
  dir: string,
  type: string,
  items: CompileConcept[],
  generated: { by: string; at: string },
  paperHref: string,
  paperTitle: string,
  vocab: AlignIndex,
  llmHits?: Map<string, AlignEntry>,
): Promise<{
  paths: string[];
  skipped: string[];
  hrefs: { title: string; href: string }[];
  rewrites: { from: string; to: string }[];
}> {
  const paths: string[] = [];
  const skipped: string[] = [];
  const hrefs: { title: string; href: string }[] = [];
  const rewrites: { from: string; to: string }[] = [];
  for (const item of items) {
    const naivePath = `${dir}/${conceptSlug(item.title)}.md`;
    const aligned = vocab.lookup(type, item.title)
      ?? llmHits?.get(normalizeAlignKey(item.title));
    const path = aligned?.path ?? naivePath;
    const canonicalTitle = aligned?.title ?? item.title;
    hrefs.push({ title: canonicalTitle, href: `/${path}` });
    if (naivePath !== path) {
      rewrites.push({ from: naivePath, to: path });
    }
    const result = await upsertRelated(store, path, {
      type,
      title: canonicalTitle,
      incomingTitle: item.title,
      tags: item.tags,
      generated,
      body: item.body,
      paperTitle,
      paperHref,
    });
    if (result === "skipped") {
      skipped.push(path);
    } else {
      paths.push(path);
    }
    if (!aligned) {
      vocab.add({
        path,
        id: path.replace(/\.md$/i, ""),
        type,
        title: canonicalTitle,
        aliases: [],
      });
    } else if (normalizeAlignKey(item.title) !== normalizeAlignKey(canonicalTitle)) {
      vocab.add({
        ...aligned,
        aliases: [...aligned.aliases, item.title],
      });
    }
  }
  return { paths, skipped, hrefs, rewrites };
}

async function rewriteConceptBodies(
  store: FileStore,
  concepts: CompileConcept[],
  paperHref: string,
  upcoming: Set<string>,
): Promise<CompileConcept[]> {
  return Promise.all(
    concepts.map(async (concept) => ({
      ...concept,
      body: await sanitizeBodyLinks(store, concept.body, paperHref, upcoming),
    })),
  );
}

async function requestOutput(
  client: ChatClient,
  input: CompileInput,
  vocabulary: string,
  stages: Set<CompileStage>,
): Promise<CompileOutput> {
  const system = compileSystemPrompt({ genes: stages.has("genes"), pathways: stages.has("pathways") });
  const first = await client.complete([
    { role: "system", content: system },
    { role: "user", content: compileUserPrompt({ ...input, vocabulary }) },
  ]);
  try {
    return parseCompileOutput(first);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const repaired = await client.complete([
      { role: "system", content: system },
      { role: "user", content: repairUserPrompt(first, message) },
    ]);
    return parseCompileOutput(repaired);
  }
}

async function requestSegmentOutput(
  client: ChatClient,
  input: {
    paperTitle: string;
    segmentIndex: number;
    segmentCount: number;
    extractText: string;
    knownTitles: string;
    vocabulary: string;
  },
  stages: Set<CompileStage>,
): Promise<CompileSegmentOutput> {
  const system = compileSegmentSystemPrompt({ genes: stages.has("genes"), pathways: stages.has("pathways") });
  const user = compileSegmentUserPrompt({
    paperTitle: input.paperTitle,
    segmentIndex: input.segmentIndex,
    segmentCount: input.segmentCount,
    extractText: input.extractText,
    knownTitles: input.knownTitles || undefined,
    vocabulary: input.vocabulary || undefined,
  });
  const first = await client.complete([
    { role: "system", content: system },
    { role: "user", content: user },
  ]);
  try {
    return parseSegmentOutput(first);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const repaired = await client.complete([
      { role: "system", content: system },
      { role: "user", content: repairUserPrompt(first, message) },
    ]);
    return parseSegmentOutput(repaired);
  }
}

async function requestMoreClaims(
  client: ChatClient,
  paperTitle: string,
  tails: string[],
): Promise<CompileClaim[]> {
  // One model call per tail segment; a small pool means a 5-segment paper
  // pays ~2 call latencies instead of 5. mapPool preserves segment order,
  // so claim order matches the serial implementation.
  const perSegment = await mapPool(tails, 3, async (segment) => {
    const raw = await client.complete([
      { role: "system", content: CLAIMS_SYSTEM_PROMPT },
      { role: "user", content: claimsUserPrompt(paperTitle, segment) },
    ]);
    try {
      return parseClaimsOnly(raw);
    } catch {
      // Keep claims from the main compile pass.
      return [] as CompileClaim[];
    }
  });
  return perSegment.flat();
}

export async function compileExtract(
  store: FileStore,
  client: ChatClient,
  input: CompileInput,
  options: CompileOptions,
): Promise<CompileResult> {
  const stages = selectedStages(options);
  const generated = {
    by: generatedBy(options.model),
    at: options.now ?? new Date().toISOString(),
  };
  const vocab = options.alignVocabulary ?? (await loadAlignVocabulary(store));
  const segments = segmentExtract(input.extractText, EXTRACT_CHAR_LIMIT);
  const windows = segments.length > 0 ? segments : [input.extractText];
  const needCompileJson = stages.has("biblio") || stages.has("concepts") || stages.has("digest");

  const existingPaper =
    options.paperPath && (await store.exists(options.paperPath))
      ? parseDocument(utf8Decode(await store.read(options.paperPath)))
      : undefined;
  const existingTitle = asString(existingPaper?.frontmatter.title);

  if (!needCompileJson && stages.has("claims") && existingPaper) {
    // Claims-only runs attach to an existing paper. If the paper file is
    // missing (options.paperPath set but not on disk), fall through to the
    // full path so the paper is created instead of leaving dangling refs.
    // A human-verified paper is never rewritten, mirroring upsertPaper.
    const paperPath = options.paperPath!;
    const paperTitle = existingTitle ?? "Untitled";
    if (isHumanVerified(existingPaper.frontmatter)) {
      return { paperPath, written: [], skippedVerified: [paperPath] };
    }
    const cached = options.resumeCompile !== false ? await loadCompileOutput(store, input.extractText) : undefined;
    let extra: CompileClaim[];
    if (cached?.kind === "claims") {
      extra = cached.claims;
    } else {
      extra = await requestMoreClaims(client, paperTitle, windows);
      await saveCompileOutput(store, input.extractText, { kind: "claims", claims: extra });
    }
    const claims = await writeClaims(store, {
      paperPath,
      paperTitle,
      doi: asString(existingPaper.frontmatter.doi),
      extractPath: input.extractPath,
      extractText: input.extractText,
      claims: extra,
      generated,
    });
    if (claims.omitted > 0) {
      options.onLog?.(`compile ${input.pdfFilename} dropped ${claims.omitted} unquoted claim(s)`);
    }
    let body = existingPaper.body;
    for (const link of claims.hrefs) {
      body = ensureLink(body, link.title, link.href);
    }
    // Claims-only keeps the pre-existing paper body, so only guard the newly
    // written claim bodies; never punish dead links inherited from old builds.
    let guard;
    try {
      guard = await guardCompileLinks(store, {
        paperBody: body,
        checkPaperBody: false,
        extraBodies: extra
          .map((claim) => ({ body: claim.body ?? "", scope: "claim" }))
          .filter((item) => item.body.trim().length > 0),
        repairConcepts: true,
        vocab,
        paperTitle,
        paperHref: `/${paperPath.replace(/^\/+/, "")}`,
        generated,
        knownPaths: [paperPath],
        output: extra,
      });
    } catch (error) {
      if (error instanceof DeadLinkError) {
        await clearCompileOutput(store, input.extractText);
      }
      throw error;
    }
    body = guard.paperBody;
    if (body !== existingPaper.body) {
      await store.write(paperPath, serializeDocument(existingPaper.frontmatter, body));
    }
    if (input.extractPath && (await store.exists(input.extractPath))) {
      await bindExtractToPaper(store, input.extractPath, paperPath, asString(existingPaper.frontmatter.doi));
    }
    await clearCompileOutput(store, input.extractText);
    return {
      paperPath,
      written: [...claims.written, ...guard.written],
      skippedVerified: claims.skipped,
    };
  }

  // The .okf rebuildable cache only short-circuits the model call when the
  // cached run covered the requested optional stages (a cached default run has
  // no genes/pathways; reusing it would silently swallow an opt-in request).
  const cached = options.resumeCompile !== false
    ? await loadCompileOutput(store, input.extractText, stages)
    : undefined;
  let output: CompileOutput;
  if (cached?.kind === "full") {
    output = cached.output;
  } else {
    options.onLog?.(
      windows.length === 1
        ? `compile ${input.pdfFilename} 1 segment`
        : `compile ${input.pdfFilename} ${windows.length} segments (full extract)`,
    );
    const head = await requestOutput(
      client,
      { ...input, extractText: windows[0] ?? "" },
      formatVocabularyForPrompt(vocab),
      stages,
    );
    const tails = windows.slice(1);
    if (tails.length === 0 || !needCompileJson) {
      output = head;
      if (tails.length > 0 && stages.has("claims")) {
        const extra = await requestMoreClaims(client, head.paper.title, tails);
        output = { ...head, claims: [...head.claims, ...extra] };
      }
    } else {
      const known = knownTitlesOf(head);
      const vocabulary = formatVocabularyForPrompt(vocab);
      const extras = await mapPool(tails, SEGMENT_COMPILE_CONCURRENCY, async (segment, offset) => {
        const index = offset + 1;
        options.onLog?.(`compile ${input.pdfFilename} segment ${index + 1}/${windows.length}`);
        return requestSegmentOutput(
          client,
          {
            paperTitle: head.paper.title,
            segmentIndex: index,
            segmentCount: windows.length,
            extractText: segment,
            knownTitles: known,
            vocabulary,
          },
          stages,
        );
      });
      output = mergeCompileOutput(head, extras);
    }
  }
  let paper = output.paper;
  let published = resolvePublished(paper.published, input.pdfFilename, input.pdfCreationDate);
  let biblioMeta: BiblioFrontmatter | undefined;
  if (stages.has("biblio") && options.biblio) {
    try {
      const yearHint = published ? publishedYear(published) : yearFromFilename(input.pdfFilename);
      const hit = await options.biblio.lookup({
        doi: paper.doi,
        title: paper.title,
        year: yearHint,
      });
      const applied = applyBiblio(
        {
          title: paper.title,
          doi: paper.doi,
          authors: paper.authors,
          venue: paper.venue,
          published,
        },
        hit,
      );
      paper = {
        ...paper,
        title: applied.next.title,
        doi: applied.next.doi,
        authors: applied.next.authors,
        venue: applied.next.venue,
        published: applied.next.published,
      };
      published = applied.next.published ?? published;
      biblioMeta = applied.biblio;
    } catch (error) {
      // Optional enrichment; compile continues offline. Keep the failure visible
      // in logs instead of swallowing it silently.
      console.error(`[okf] biblio enrichment failed for ${input.pdfFilename}:`, error instanceof Error ? error.message : error);
    }
  }
  const year = (published ? publishedYear(published) : undefined) ?? "undated";
  const paperPath = options.paperPath ?? `papers/${slugify(year, paper.title)}.md`;
  const paperHref = `/${paperPath}`;
  const resource = `/${input.pdfStorePath.replace(/^\/+/, "")}`;

  // Sanitize hallucinated links before anything is written. The upcoming-set
  // lists pages this run is about to write (naive slug path + any aligned
  // existing path), so legit cross-links between concepts of this same run
  // survive while invented directories (/paper/, /domains/) and phantom
  // targets are unlinked instead of hard-failing the compile.
  const llmHits = (stages.has("concepts") || stages.has("pathways"))
    ? await aliasAlignIncoming(
        client,
        vocab,
        [
          ...(stages.has("concepts")
            ? [
                ...output.topics.map((item) => ({ type: "Topic", title: item.title })),
                ...output.methods.map((item) => ({ type: "Method", title: item.title })),
                ...output.entities.map((item) => ({ type: "Entity", title: item.title })),
                ...output.datasets.map((item) => ({ type: "Dataset", title: item.title })),
              ]
            : []),
          ...(stages.has("pathways")
            ? output.pathways.map((item) => ({ type: "Pathway", title: item.title }))
            : []),
        ],
        { onLog: options.onLog },
      )
    : new Map<string, AlignEntry>();

  const upcoming = new Set<string>();
  const conceptGroups: Array<[CompileConcept[], string, string]> = [
    [output.topics, "topics", "Topic"],
    [output.methods, "methods", "Method"],
    [output.entities, "entities", "Entity"],
    [output.datasets, "datasets", "Dataset"],
    [output.genes, "genes", "Gene"],
    [output.pathways, "pathways", "Pathway"],
  ];
  for (const [items, dir, type] of conceptGroups) {
    for (const item of items) {
      upcoming.add(`${dir}/${conceptSlug(item.title)}.md`);
      const aligned = vocab.lookup(type, item.title)
        ?? llmHits.get(normalizeAlignKey(item.title));
      if (aligned) {
        upcoming.add(aligned.path.replace(/^\/+/, "").replace(/\.md$/i, "") + ".md");
      }
    }
  }
  output = {
    ...output,
    paper: { ...output.paper, body: await sanitizeBodyLinks(store, output.paper.body, paperHref, upcoming) },
    topics: await rewriteConceptBodies(store, output.topics, paperHref, upcoming),
    methods: await rewriteConceptBodies(store, output.methods, paperHref, upcoming),
    entities: await rewriteConceptBodies(store, output.entities, paperHref, upcoming),
    datasets: await rewriteConceptBodies(store, output.datasets, paperHref, upcoming),
    genes: await rewriteConceptBodies(store, output.genes, paperHref, upcoming),
    pathways: await rewriteConceptBodies(store, output.pathways, paperHref, upcoming),
  };

  const emptyRelated = { paths: [] as string[], skipped: [] as string[], hrefs: [] as { title: string; href: string }[], rewrites: [] as { from: string; to: string }[] };
  const topics = stages.has("concepts")
    ? await writeRelated(store, "topics", "Topic", output.topics, generated, paperHref, paper.title, vocab, llmHits)
    : emptyRelated;
  const methods = stages.has("concepts")
    ? await writeRelated(store, "methods", "Method", output.methods, generated, paperHref, paper.title, vocab, llmHits)
    : emptyRelated;
  const entities = stages.has("concepts")
    ? await writeRelated(store, "entities", "Entity", output.entities, generated, paperHref, paper.title, vocab, llmHits)
    : emptyRelated;
  const datasets = stages.has("concepts")
    ? await writeRelated(store, "datasets", "Dataset", output.datasets, generated, paperHref, paper.title, vocab, llmHits)
    : emptyRelated;
  const genes = stages.has("genes")
    ? await writeRelated(store, "genes", "Gene", output.genes, generated, paperHref, paper.title, vocab)
    : emptyRelated;
  const pathways = stages.has("pathways")
    ? await writeRelated(store, "pathways", "Pathway", output.pathways, generated, paperHref, paper.title, vocab, llmHits)
    : emptyRelated;

  let paperBody = existingPaper && !stages.has("digest") ? existingPaper.body : output.paper.body;
  for (const rewrite of [...topics.rewrites, ...methods.rewrites, ...entities.rewrites, ...datasets.rewrites, ...genes.rewrites, ...pathways.rewrites]) {
    paperBody = rewriteBundleHref(paperBody, rewrite.from, rewrite.to);
  }
  for (const link of [...topics.hrefs, ...methods.hrefs, ...entities.hrefs, ...datasets.hrefs, ...genes.hrefs, ...pathways.hrefs]) {
    paperBody = ensureLink(paperBody, link.title, link.href);
  }

  const hubWritten = [
    ...topics.paths,
    ...methods.paths,
    ...entities.paths,
    ...datasets.paths,
    ...genes.paths,
    ...pathways.paths,
  ];
  if (hubWritten.length > 0) {
    const merges = await consolidateHubs(store, vocab, { onlyPaths: hubWritten, onLog: options.onLog });
    paperBody = applyHubMergesToBody(paperBody, merges);
  }

  const claimSeed = stages.has("claims") ? output.claims : [];
  const finalClaims = claimSeed;
  if (cached?.kind !== "full") {
    // Persist the model output to the rebuildable cache so a later guard
    // failure resumes from the write phase instead of re-running the model.
    // The stage set travels with the payload so an opt-in genes/pathways run
    // is never answered from a cache produced without them.
    await saveCompileOutput(store, input.extractText, {
      kind: "full",
      output: { ...output, claims: finalClaims },
      stages: [...stages].sort(),
    });
  }
  const claims = stages.has("claims")
    ? await writeClaims(store, {
        paperPath,
        paperTitle: paper.title,
        doi: paper.doi,
        extractPath: input.extractPath,
        extractText: input.extractText,
        claims: finalClaims,
        generated,
      })
    : { written: [] as string[], skipped: [] as string[], omitted: 0, hrefs: [] as { title: string; href: string }[] };
  if (claims.omitted > 0) {
    options.onLog?.(`compile ${input.pdfFilename} dropped ${claims.omitted} unquoted claim(s)`);
  }
  for (const link of claims.hrefs) {
    paperBody = ensureLink(paperBody, link.title, link.href);
  }

  // Link-integrity guard: repair repairable dead links, then hard-fail on the
  // rest so the library never gains an isolated node silently.
  let guard;
  try {
    guard = await guardCompileLinks(store, {
      paperBody,
      checkPaperBody: stages.has("digest") || !existingPaper,
      extraBodies: [
        ...(stages.has("concepts")
          ? [...output.topics, ...output.methods, ...output.entities, ...output.datasets].map((c) => ({ body: c.body, scope: "concept" }))
          : []),
        ...(stages.has("genes") ? output.genes.map((c) => ({ body: c.body, scope: "concept" })) : []),
        ...(stages.has("pathways") ? output.pathways.map((c) => ({ body: c.body, scope: "concept" })) : []),
        ...(stages.has("claims") ? finalClaims.map((c) => ({ body: c.body ?? "", scope: "claim" })) : []),
      ].filter((item) => item.body.trim().length > 0),
      repairConcepts: true,
      vocab,
      paperTitle: paper.title,
      paperHref,
      generated,
      knownPaths: [paperPath],
      output: { ...output, claims: finalClaims },
    });
  } catch (error) {
    if (error instanceof DeadLinkError) {
      // The persisted snapshot itself produced these dead links; replaying it
      // on retry fails identically forever. Drop it so the next run calls the
      // model fresh (resume-from-cache stays available for IO failures).
      await clearCompileOutput(store, input.extractText);
    }
    throw error;
  }
  paperBody = guard.paperBody;

  const existingFm = existingPaper?.frontmatter ?? {};
  const nextFrontmatter = {
    ...existingFm,
    type: "Paper",
    title: stages.has("biblio") ? paper.title : (asString(existingFm.title) ?? paper.title),
    description: stages.has("biblio")
      ? (paper.description ?? "")
      : (asString(existingFm.description) ?? paper.description ?? ""),
    resource: asString(existingFm.resource) ?? resource,
    tags: stages.has("biblio") ? (paper.tags ?? []) : asTags(existingFm.tags).length > 0 ? asTags(existingFm.tags) : (paper.tags ?? []),
    doi: stages.has("biblio") ? (paper.doi ?? "") : (asString(existingFm.doi) ?? paper.doi ?? ""),
    authors: stages.has("biblio") ? (paper.authors ?? []) : existingFm.authors ?? paper.authors ?? [],
    venue: stages.has("biblio") ? (paper.venue ?? "") : (asString(existingFm.venue) ?? paper.venue ?? ""),
    ...(stages.has("biblio")
      ? published
        ? { published }
        : {}
      : asString(existingFm.published)
        ? { published: existingFm.published }
        : published
          ? { published }
          : {}),
    generated,
    ...(biblioMeta ? { biblio: biblioMeta } : {}),
    // Stamp the schema version + extract fingerprint when this run (re-)
    // extracted concepts, so batch compiles can skip papers already compiled
    // with the current schema and unchanged extract text. compileStages is the
    // union of everything this paper has been compiled with: an opt-in
    // genes/pathways run must be able to tell that a paper stamped by a
    // default-only run still needs the model pass.
    ...(stages.has("concepts") || stages.has("genes") || stages.has("pathways")
      ? {
          compileVersion: COMPILE_SCHEMA_VERSION,
          extractHash: extractTextHash(input.extractText),
          compileStages: [...new Set([
            ...coveredCompileStages(existingFm),
            ...stages,
          ])].sort(),
        }
      : {}),
    sources: existingFm.sources ?? [
      {
        id: "pdf",
        resource,
        title: "original PDF",
      },
    ],
  };

  const shouldWritePaper = stages.has("biblio") || stages.has("digest") || stages.has("concepts") || stages.has("claims");
  const paperWrite = shouldWritePaper
    ? await upsertPaper(store, paperPath, nextFrontmatter, paperBody)
    : "skipped";

  if (input.extractPath && (await store.exists(input.extractPath))) {
    await bindExtractToPaper(store, input.extractPath, paperPath, paper.doi);
  }
  await clearCompileOutput(store, input.extractText);

  return {
    paperPath,
    written: [
      ...(paperWrite === "written" ? [paperPath] : []),
      ...topics.paths,
      ...methods.paths,
      ...entities.paths,
      ...datasets.paths,
      ...genes.paths,
      ...pathways.paths,
      ...claims.written,
      ...guard.written,
    ],
    skippedVerified: [
      ...(paperWrite === "skipped" ? [paperPath] : []),
      ...topics.skipped,
      ...methods.skipped,
      ...entities.skipped,
      ...datasets.skipped,
      ...genes.skipped,
      ...pathways.skipped,
      ...claims.skipped,
    ],
  };
}

