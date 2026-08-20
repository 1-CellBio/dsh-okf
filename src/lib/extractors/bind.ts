import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import {
  asString,
  displayDoi,
  normalizeDoi,
  normalizeResource,
  paperConceptId,
} from "@/lib/okf/identity";
import { parseDocument } from "@/lib/okf/parse";
import { serializeDocument } from "@/lib/okf/serialize";
import { loadState } from "@/lib/pipeline/state";

export async function bindExtractToPaper(
  store: FileStore,
  extractPath: string,
  paperIdOrPath: string,
  doi?: string,
): Promise<void> {
  const doc = parseDocument(utf8Decode(await store.read(extractPath)));
  const paper = paperConceptId(paperIdOrPath);
  const nextDoi = displayDoi(doi) ?? displayDoi(doc.frontmatter.doi);
  const frontmatter = {
    ...doc.frontmatter,
    paper,
    ...(nextDoi ? { doi: nextDoi } : {}),
  };
  await store.write(extractPath, serializeDocument(frontmatter, doc.body));
}

type PaperRef = { id: string; doi?: string };

export function resourcesFromFrontmatter(frontmatter: Record<string, unknown>): string[] {
  const out: string[] = [];
  const resource = normalizeResource(frontmatter.resource);
  if (resource) {
    out.push(resource);
  }
  const sources = frontmatter.sources;
  if (Array.isArray(sources)) {
    for (const source of sources) {
      if (source && typeof source === "object" && "resource" in source) {
        const path = normalizeResource((source as { resource: unknown }).resource);
        if (path) {
          out.push(path);
        }
      }
    }
  }
  return out;
}

/** Fill `paper` / `doi` on extracts that were written before compile binding existed. */
export async function backfillExtractBindings(store: FileStore): Promise<string[]> {
  const papers = (await store.list("papers/")).filter((path) => path.endsWith(".md"));
  const byResource = new Map<string, PaperRef>();
  const byDoi = new Map<string, PaperRef>();
  const byId = new Map<string, PaperRef>();

  for (const path of papers) {
    const doc = parseDocument(utf8Decode(await store.read(path)));
    const id = paperConceptId(path);
    const doi = normalizeDoi(doc.frontmatter.doi);
    const displayDoi = asString(doc.frontmatter.doi);
    const ref: PaperRef = { id, doi: displayDoi };
    byId.set(id, ref);
    for (const resource of resourcesFromFrontmatter(doc.frontmatter)) {
      byResource.set(resource, ref);
    }
    if (doi) {
      byDoi.set(doi, ref);
    }
  }

  const byExtractPath = new Map<string, PaperRef>();
  const state = await loadState(store);
  for (const record of Object.values(state.pdfs)) {
    if (!record.extract || !record.paper) {
      continue;
    }
    const id = paperConceptId(record.paper);
    const fromPaper = byId.get(id);
    byExtractPath.set(record.extract.replace(/^\/+/, ""), fromPaper ?? { id });
  }

  const updated: string[] = [];
  const extracts = (await store.list("extracts/")).filter((path) => path.endsWith(".md"));
  for (const path of extracts) {
    const doc = parseDocument(utf8Decode(await store.read(path)));
    const existingPaper = asString(doc.frontmatter.paper)
      ? paperConceptId(String(doc.frontmatter.paper))
      : undefined;
    const resource = normalizeResource(doc.frontmatter.resource);
    const doiKey = normalizeDoi(doc.frontmatter.doi);
    const match =
      (existingPaper ? byId.get(existingPaper) : undefined) ??
      byExtractPath.get(path) ??
      (resource ? byResource.get(resource) : undefined) ??
      (doiKey ? byDoi.get(doiKey) : undefined);
    if (!match) {
      continue;
    }
    const needPaper = existingPaper !== match.id;
    const needDoi = Boolean(match.doi) && asString(doc.frontmatter.doi) !== match.doi;
    if (!needPaper && !needDoi) {
      continue;
    }
    await bindExtractToPaper(store, path, match.id, match.doi);
    updated.push(path);
  }
  return updated;
}
