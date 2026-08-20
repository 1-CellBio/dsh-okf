import { okfCachePath } from "@/lib/okf/cache";
import { isPackPath } from "./pack";
import { claimMergeKey } from "@/lib/compile/claims";
import { mergePaperLinks } from "@/lib/compile/mergeLinks";
import { bindExtractToPaper } from "@/lib/extractors/bind";
import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import {
  asString,
  claimPathFor,
  displayDoi,
  normalizeDoi,
  paperConceptId,
  titleYearKey,
  unionTags,
} from "@/lib/okf/identity";
import { parseDocument } from "@/lib/okf/parse";
import { serializeDocument } from "@/lib/okf/serialize";
import { conceptSlug } from "@/lib/okf/slug";
import { isHumanVerified } from "@/lib/okf/validate";
import { bootstrapBundle } from "@/lib/pipeline/bootstrap";
import { refreshRootIndex } from "@/lib/pipeline/log";
import { mergeGeneratedBlocks } from "@/lib/survey/generated";
import type { Frontmatter } from "@/types/okf";

export type MergeConflict = {
  path: string;
  reason: string;
};

export type MergeReport = {
  added: string[];
  merged: string[];
  skipped: string[];
  conflicts: MergeConflict[];
};

type ParsedFile = {
  path: string;
  frontmatter: Frontmatter;
  body: string;
};

async function readMarkdown(store: FileStore, path: string): Promise<ParsedFile> {
  const doc = parseDocument(utf8Decode(await store.read(path)));
  return { path, frontmatter: doc.frontmatter, body: doc.body };
}

async function listMarkdown(store: FileStore, prefix: string): Promise<string[]> {
  return (await store.list(prefix)).filter((path) => path.endsWith(".md") && isPackPath(path));
}

async function uniquePath(store: FileStore, desired: string): Promise<string> {
  if (!(await store.exists(desired))) {
    return desired;
  }
  const base = desired.replace(/\.md$/i, "");
  let n = 2;
  while (await store.exists(`${base}-${n}.md`)) {
    n += 1;
  }
  return `${base}-${n}.md`;
}

function generatedAt(frontmatter: Frontmatter): string {
  const generated = frontmatter.generated;
  if (generated && typeof generated === "object" && generated !== null && "at" in generated) {
    return asString((generated as { at: unknown }).at) ?? "";
  }
  return "";
}

function paperLookupKeys(file: ParsedFile): { doi?: string; titleYear?: string } {
  const doi = normalizeDoi(file.frontmatter.doi);
  const title = asString(file.frontmatter.title);
  const published = asString(file.frontmatter.published);
  return {
    doi,
    titleYear: title ? titleYearKey(title, published) : undefined,
  };
}

async function loadPapers(store: FileStore): Promise<ParsedFile[]> {
  const paths = await listMarkdown(store, "papers/");
  const files: ParsedFile[] = [];
  for (const path of paths) {
    files.push(await readMarkdown(store, path));
  }
  return files;
}

type PaperIndex = {
  byDoi: Map<string, ParsedFile>;
  byTitleYear: Map<string, ParsedFile>;
};

/** First match wins, mirroring the old linear `find` scan, so lookup stays
 * O(1) instead of scanning every destination paper per incoming paper. */
function buildPaperIndex(destPapers: ParsedFile[]): PaperIndex {
  const index: PaperIndex = { byDoi: new Map(), byTitleYear: new Map() };
  for (const paper of destPapers) {
    indexPaper(index, paper);
  }
  return index;
}

function indexPaper(index: PaperIndex, paper: ParsedFile): void {
  const keys = paperLookupKeys(paper);
  if (keys.doi && !index.byDoi.has(keys.doi)) {
    index.byDoi.set(keys.doi, paper);
  }
  if (keys.titleYear && !index.byTitleYear.has(keys.titleYear)) {
    index.byTitleYear.set(keys.titleYear, paper);
  }
}

function findDestPaper(incoming: ParsedFile, index: PaperIndex): ParsedFile | undefined {
  const keys = paperLookupKeys(incoming);
  if (keys.doi) {
    const byDoi = index.byDoi.get(keys.doi);
    if (byDoi) {
      return byDoi;
    }
  }
  if (keys.titleYear) {
    return index.byTitleYear.get(keys.titleYear);
  }
  return undefined;
}

function extractKey(file: ParsedFile): string {
  const doi = normalizeDoi(file.frontmatter.doi);
  if (doi) {
    return `doi:${doi}`;
  }
  const paper = asString(file.frontmatter.paper);
  if (paper) {
    return `paper:${paperConceptId(paper)}`;
  }
  const title = asString(file.frontmatter.title);
  if (title) {
    return `title:${conceptSlug(title)}`;
  }
  const stem = file.path.split("/").pop()?.replace(/\.md$/i, "") ?? file.path;
  return `stem:${stem}`;
}

function incomingRicher(dest: ParsedFile, incoming: ParsedFile, sameDoi: boolean): boolean {
  return sameDoi && incoming.body.trim().length > dest.body.trim().length;
}

async function writeDoc(
  store: FileStore,
  path: string,
  frontmatter: Frontmatter,
  body: string,
): Promise<void> {
  await store.write(path, serializeDocument(frontmatter, body));
}

function emptyReport(): MergeReport {
  return { added: [], merged: [], skipped: [], conflicts: [] };
}

function pushUnique(list: string[], path: string): void {
  if (!list.includes(path)) {
    list.push(path);
  }
}

async function mergePapers(
  src: FileStore,
  dst: FileStore,
  report: MergeReport,
): Promise<Map<string, string>> {
  const remap = new Map<string, string>();
  const destPapers = await loadPapers(dst);
  const destIndex = buildPaperIndex(destPapers);
  const incomingPaths = await listMarkdown(src, "papers/");

  for (const path of incomingPaths) {
    const incoming = await readMarkdown(src, path);
    const incomingId = paperConceptId(path);
    const dest = findDestPaper(incoming, destIndex);
    if (!dest) {
      const outPath = await uniquePath(dst, path);
      await writeDoc(dst, outPath, incoming.frontmatter, incoming.body);
      const added = { ...incoming, path: outPath };
      destPapers.push(added);
      indexPaper(destIndex, added);
      remap.set(incomingId, paperConceptId(outPath));
      pushUnique(report.added, outPath);
      continue;
    }

    const destId = paperConceptId(dest.path);
    remap.set(incomingId, destId);
    const sameDoi = Boolean(
      normalizeDoi(incoming.frontmatter.doi) &&
        normalizeDoi(incoming.frontmatter.doi) === normalizeDoi(dest.frontmatter.doi),
    );
    const tags = unionTags(dest.frontmatter.tags, incoming.frontmatter.tags);

    if (isHumanVerified(dest.frontmatter)) {
      await writeDoc(dst, dest.path, { ...dest.frontmatter, tags }, dest.body);
      pushUnique(report.skipped, dest.path);
      if (incoming.body.trim() !== dest.body.trim()) {
        report.conflicts.push({
          path: dest.path,
          reason: "destination is human-verified; incoming paper body was not applied",
        });
      }
      dest.frontmatter = { ...dest.frontmatter, tags };
      continue;
    }

    if (incomingRicher(dest, incoming, sameDoi)) {
      await writeDoc(
        dst,
        dest.path,
        {
          ...incoming.frontmatter,
          tags,
          ...(dest.frontmatter.verified ? { verified: dest.frontmatter.verified } : {}),
        },
        incoming.body,
      );
      dest.frontmatter = { ...incoming.frontmatter, tags };
      dest.body = incoming.body;
      pushUnique(report.merged, dest.path);
      continue;
    }

    await writeDoc(dst, dest.path, { ...dest.frontmatter, tags }, dest.body);
    dest.frontmatter = { ...dest.frontmatter, tags };
    pushUnique(report.merged, dest.path);
    if (incoming.body.trim() !== dest.body.trim()) {
      report.conflicts.push({
        path: dest.path,
        reason: sameDoi
          ? "same DOI; kept existing body because incoming digest is not strictly longer"
          : "matched by title+year; kept existing body",
      });
    }
  }

  return remap;
}

async function applyPaperRemap(store: FileStore, remap: Map<string, string>): Promise<void> {
  const changed = [...remap.entries()].filter(([from, to]) => from !== to);
  if (changed.length === 0) {
    return;
  }
  for (const prefix of ["papers/", "topics/", "methods/", "entities/", "datasets/", "genes/", "pathways/", "claims/", "notes/", "questions/", "surveys/"] as const) {
    for (const path of await listMarkdown(store, prefix)) {
      const file = await readMarkdown(store, path);
      let body = file.body;
      let frontmatter = file.frontmatter;
      for (const [from, to] of changed) {
        body = body.replaceAll(`/${from}.md`, `/${to}.md`);
        if (asString(frontmatter.paper) && paperConceptId(String(frontmatter.paper)) === from) {
          frontmatter = { ...frontmatter, paper: to };
        }
      }
      if (body !== file.body || frontmatter !== file.frontmatter) {
        await writeDoc(store, path, frontmatter, body);
      }
    }
  }
}

async function mergeConcepts(
  src: FileStore,
  dst: FileStore,
  dir: string,
  type: string,
  report: MergeReport,
): Promise<void> {
  const incomingPaths = await listMarkdown(src, dir);
  for (const path of incomingPaths) {
    const incoming = await readMarkdown(src, path);
    if (!(await dst.exists(path))) {
      await writeDoc(dst, path, incoming.frontmatter, incoming.body);
      pushUnique(report.added, path);
      continue;
    }
    const dest = await readMarkdown(dst, path);
    const tags = unionTags(dest.frontmatter.tags, incoming.frontmatter.tags);
    if (isHumanVerified(dest.frontmatter)) {
      const nextBody = mergePaperLinks(incoming.body, dest.body);
      await writeDoc(dst, path, { ...dest.frontmatter, tags, type }, nextBody);
      pushUnique(report.skipped, path);
      if (incoming.body.trim() !== dest.body.trim()) {
        report.conflicts.push({
          path,
          reason: "destination is human-verified; kept local body and unioned Paper links",
        });
      }
      continue;
    }
    const nextBody = mergePaperLinks(dest.body, incoming.body);
    await writeDoc(
      dst,
      path,
      {
        ...incoming.frontmatter,
        tags,
        type,
        title: asString(dest.frontmatter.title) ?? incoming.frontmatter.title,
      },
      nextBody,
    );
    pushUnique(report.merged, path);
  }
}

function preferExtract(dest: ParsedFile, incoming: ParsedFile): ParsedFile {
  const destLen = dest.body.trim().length;
  const incomingLen = incoming.body.trim().length;
  if (incomingLen > destLen) {
    return incoming;
  }
  if (incomingLen < destLen) {
    return dest;
  }
  return generatedAt(incoming.frontmatter) > generatedAt(dest.frontmatter) ? incoming : dest;
}

async function mergeExtracts(
  src: FileStore,
  dst: FileStore,
  paperRemap: Map<string, string>,
  report: MergeReport,
): Promise<void> {
  const destPaths = await listMarkdown(dst, "extracts/");
  const destByKey = new Map<string, ParsedFile>();
  for (const path of destPaths) {
    const file = await readMarkdown(dst, path);
    destByKey.set(extractKey(file), file);
  }

  const incomingPaths = await listMarkdown(src, "extracts/");
  for (const path of incomingPaths) {
    const incoming = await readMarkdown(src, path);
    const mappedPaper = asString(incoming.frontmatter.paper)
      ? paperRemap.get(paperConceptId(String(incoming.frontmatter.paper))) ??
        paperConceptId(String(incoming.frontmatter.paper))
      : undefined;
    const incomingWithPaper: ParsedFile = {
      ...incoming,
      frontmatter: {
        ...incoming.frontmatter,
        ...(mappedPaper ? { paper: mappedPaper } : {}),
      },
    };
    const key = extractKey(incomingWithPaper);
    const dest = destByKey.get(key);
    if (!dest) {
      const outPath = await uniquePath(dst, path);
      await writeDoc(dst, outPath, incomingWithPaper.frontmatter, incoming.body);
      if (mappedPaper) {
        await bindExtractToPaper(
          dst,
          outPath,
          mappedPaper,
          displayDoi(incomingWithPaper.frontmatter.doi),
        );
      }
      destByKey.set(key, { ...incomingWithPaper, path: outPath });
      pushUnique(report.added, outPath);
      continue;
    }

    const chosen = preferExtract(dest, incomingWithPaper);
    const paper = mappedPaper ?? asString(dest.frontmatter.paper);
    const doi = displayDoi(incomingWithPaper.frontmatter.doi) ?? displayDoi(dest.frontmatter.doi);
    const frontmatter = {
      ...chosen.frontmatter,
      ...(paper ? { paper } : {}),
      ...(doi ? { doi } : {}),
    };
    await writeDoc(dst, dest.path, frontmatter, chosen.body);
    dest.frontmatter = frontmatter;
    dest.body = chosen.body;
    destByKey.set(key, dest);
    pushUnique(report.merged, dest.path);
  }
}

function claimConfidence(frontmatter: Frontmatter): string {
  return asString(frontmatter.confidence) ?? "extracted";
}

async function mergeClaims(
  src: FileStore,
  dst: FileStore,
  paperRemap: Map<string, string>,
  report: MergeReport,
): Promise<void> {
  const destByKey = new Map<string, ParsedFile>();
  for (const path of await listMarkdown(dst, "claims/")) {
    const file = await readMarkdown(dst, path);
    destByKey.set(claimMergeKey(file.frontmatter, file.path), file);
  }

  for (const path of await listMarkdown(src, "claims/")) {
    const incoming = await readMarkdown(src, path);
    const mappedPaper = asString(incoming.frontmatter.paper)
      ? paperRemap.get(paperConceptId(String(incoming.frontmatter.paper))) ??
        paperConceptId(String(incoming.frontmatter.paper))
      : undefined;
    const incomingWithPaper: ParsedFile = {
      ...incoming,
      frontmatter: {
        ...incoming.frontmatter,
        ...(mappedPaper ? { paper: mappedPaper } : {}),
      },
    };
    const key = claimMergeKey(incomingWithPaper.frontmatter, path);
    const dest = destByKey.get(key);
    if (!dest) {
      const title = asString(incomingWithPaper.frontmatter.title) ?? "claim";
      const desired = mappedPaper ? claimPathFor(mappedPaper, title) : path;
      const outPath = await uniquePath(dst, desired);
      await writeDoc(dst, outPath, incomingWithPaper.frontmatter, incoming.body);
      destByKey.set(key, { ...incomingWithPaper, path: outPath });
      pushUnique(report.added, outPath);
      continue;
    }
    if (isHumanVerified(dest.frontmatter) || claimConfidence(dest.frontmatter) === "reviewed") {
      pushUnique(report.skipped, dest.path);
      if (incoming.body.trim() !== dest.body.trim()) {
        report.conflicts.push({
          path: dest.path,
          reason: "destination claim is reviewed; incoming claim was not applied",
        });
      }
      continue;
    }
    await writeDoc(dst, dest.path, incomingWithPaper.frontmatter, incoming.body);
    dest.frontmatter = incomingWithPaper.frontmatter;
    dest.body = incoming.body;
    destByKey.set(key, dest);
    pushUnique(report.merged, dest.path);
  }
}

export function formatMergeReport(report: MergeReport, now = new Date().toISOString()): string {
  const section = (title: string, lines: string[]): string[] => [
    `## ${title}`,
    ...(lines.length > 0 ? lines.map((line) => `- ${line}`) : ["- (none)"]),
    "",
  ];
  return [
    "---",
    "type: MergeReport",
    `generated: ${now}`,
    "---",
    "",
    "# Merge report",
    "",
    ...section("Added", report.added),
    ...section("Merged", report.merged),
    ...section("Skipped", report.skipped),
    ...section(
      "Conflicts",
      report.conflicts.map((item) => `${item.path}: ${item.reason}`),
    ),
  ].join("\n");
}

async function mergeSlugPages(
  src: FileStore,
  dst: FileStore,
  dir: string,
  report: MergeReport,
  kind: "note" | "question" | "survey",
): Promise<void> {
  for (const path of await listMarkdown(src, dir)) {
    const incoming = await readMarkdown(src, path);
    if (!(await dst.exists(path))) {
      await writeDoc(dst, path, incoming.frontmatter, incoming.body);
      pushUnique(report.added, path);
      continue;
    }
    const dest = await readMarkdown(dst, path);
    if (kind === "survey" && isHumanVerified(dest.frontmatter)) {
      const body = mergeGeneratedBlocks(dest.body, incoming.body);
      await writeDoc(dst, path, dest.frontmatter, body);
      pushUnique(report.merged, path);
      continue;
    }
    if (incoming.body.trim() === dest.body.trim()) {
      pushUnique(report.skipped, path);
      continue;
    }
    pushUnique(report.skipped, dest.path);
    report.conflicts.push({
      path: dest.path,
      reason: `destination ${kind} was not overwritten; incoming body differs`,
    });
  }
}

export async function mergeBundles(src: FileStore, dst: FileStore): Promise<MergeReport> {
  await bootstrapBundle(dst);
  const report = emptyReport();
  const paperRemap = await mergePapers(src, dst, report);
  await mergeConcepts(src, dst, "topics/", "Topic", report);
  await mergeConcepts(src, dst, "methods/", "Method", report);
  await mergeConcepts(src, dst, "entities/", "Entity", report);
  await mergeConcepts(src, dst, "datasets/", "Dataset", report);
  await mergeConcepts(src, dst, "genes/", "Gene", report);
  await mergeConcepts(src, dst, "pathways/", "Pathway", report);
  await applyPaperRemap(dst, paperRemap);
  await mergeExtracts(src, dst, paperRemap, report);
  await mergeClaims(src, dst, paperRemap, report);
  await mergeSlugPages(src, dst, "notes/", report, "note");
  await mergeSlugPages(src, dst, "questions/", report, "question");
  await mergeSlugPages(src, dst, "surveys/", report, "survey");
  if (report.added.length === 0 && report.merged.length === 0) {
    const packFiles = (await src.list("")).filter((path) => isPackPath(path));
    if (packFiles.length === 0) {
      throw new Error(
        "Source is not an OKF pack (need papers/, topics/, …). Merge the exported zip, or pick the unpacked folder that contains those directories.",
      );
    }
  }
  await refreshRootIndex(dst);
  await dst.write(okfCachePath("merge-report.md"), formatMergeReport(report));
  return report;
}
