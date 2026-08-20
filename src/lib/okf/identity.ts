import { toConceptId } from "./links";
import { conceptSlug, publishedYear } from "./slug";

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function asTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

export function unionTags(a: unknown, b: unknown): string[] {
  return [...new Set([...asTags(a), ...asTags(b)])];
}

function stripDoiPrefix(value: string): string {
  return value
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
}

/** DOI as stored on disk: resolver prefix removed, original case kept. */
export function displayDoi(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) {
    return undefined;
  }
  const stripped = stripDoiPrefix(raw);
  return stripped || undefined;
}

/** Lowercased DOI without resolver prefix. Undefined if empty. */
export function normalizeDoi(value: unknown): string | undefined {
  const stripped = displayDoi(value);
  return stripped ? stripped.toLowerCase() : undefined;
}

export function paperConceptId(pathOrId: string): string {
  return toConceptId(pathOrId.replace(/^\/+/, ""));
}

export function normalizeResource(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) {
    return undefined;
  }
  return raw.replace(/^\/+/, "");
}

export function titleYearKey(title: string, published?: string): string {
  const year = published ? publishedYear(published) ?? "" : "";
  return `${conceptSlug(title)}|${year}`;
}

export function paperSlug(pathOrId: string): string {
  return paperConceptId(pathOrId).replace(/^papers\//, "");
}

export {
  foldQuote,
  normalizeQuote,
  quoteFingerprint,
  quoteInExtract,
  snapQuoteToExtract,
} from "./quote";

export function claimTitleKey(paperId: string, title: string): string {
  return `${paperConceptId(paperId)}|${conceptSlug(title)}`;
}

export function claimPathFor(paperPathOrId: string, title: string): string {
  return `claims/${paperSlug(paperPathOrId)}--${conceptSlug(title)}.md`;
}
