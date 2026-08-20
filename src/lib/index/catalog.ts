import type { FileStore } from "@/lib/fs/types";
import { isOkfCachePath } from "@/lib/okf/cache";
import { asString, displayDoi } from "@/lib/okf/identity";
import { extractLinks, toConceptId } from "@/lib/okf/links";
import { parseDocument } from "@/lib/okf/parse";
import { normalizePublished } from "@/lib/okf/slug";
import { isHumanVerified, isReservedFilename, validateConcept } from "@/lib/okf/validate";
import type { ConceptRecord, OkfStatus } from "@/types/okf";

function asTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function asStatus(value: unknown): OkfStatus {
  if (value === "draft" || value === "deprecated" || value === "stable") {
    return value;
  }
  return "stable";
}

export const INDEXABLE_PREFIXES = [
  "papers/",
  "topics/",
  "methods/",
  "entities/",
  "datasets/",
  "genes/",
  "pathways/",
  "claims/",
  "notes/",
  "questions/",
  "surveys/",
  "extracts/",
] as const;

export function isIndexableMarkdown(path: string): boolean {
  if (!path.endsWith(".md")) {
    return false;
  }
  if (isOkfCachePath(path)) {
    return false;
  }
  if (isReservedFilename(path)) {
    return false;
  }
  return INDEXABLE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** List every indexable concept markdown path under the store root. */
export async function listIndexableMarkdown(store: FileStore): Promise<string[]> {
  return (await store.list("")).filter(isIndexableMarkdown);
}

export function parseConceptRecord(path: string, raw: string): ConceptRecord | undefined {
  const { frontmatter, body } = parseDocument(raw);
  if (validateConcept(frontmatter, path).length > 0) {
    return undefined;
  }
  const publishedRaw = asString(frontmatter.published);
  return {
    id: toConceptId(path),
    path,
    type: String(frontmatter.type),
    title: asString(frontmatter.title),
    // Only valid dates enter the index; an impossible date is treated as
    // undated rather than skewing string-based year/range comparisons.
    published: publishedRaw ? normalizePublished(publishedRaw) : undefined,
    tags: asTags(frontmatter.tags),
    status: asStatus(frontmatter.status),
    verifiedHuman: isHumanVerified(frontmatter),
    paper: asString(frontmatter.paper) ? toConceptId(String(frontmatter.paper)) : undefined,
    doi: displayDoi(frontmatter.doi),
    outgoing: extractLinks(body, path),
    body,
    confidence: asString(frontmatter.confidence),
    stance: asString(frontmatter.stance),
  };
}

/** Keep extract full text out of the in-memory catalog; FTS holds it. */
export function toCatalogRecord(record: ConceptRecord): ConceptRecord {
  if (record.type !== "TextExtract") {
    return record;
  }
  return { ...record, body: "" };
}

export function extractsByPaperMap(concepts: Map<string, ConceptRecord>): Map<string, string> {
  const out = new Map<string, string>();
  for (const record of concepts.values()) {
    if (record.type === "TextExtract" && record.paper && !out.has(record.paper)) {
      out.set(record.paper, record.id);
    }
  }
  return out;
}
