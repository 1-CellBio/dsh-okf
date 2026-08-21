/** Types that may attach to an existing hub via shared significant tokens. */
export const TOKEN_ALIGN_TYPES = new Set(["Topic", "Method", "Entity", "Pathway", "Dataset"]);

const STOP = new Set([
  "a",
  "an",
  "and",
  "based",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "using",
  "via",
  "vs",
  "with",
  "signaling",
  "signalling",
  "pathway",
  "pathways",
  "analysis",
  "analyses",
  "assay",
  "assays",
  "method",
  "methods",
  "approach",
  "approaches",
  "model",
  "models",
  "study",
  "studies",
  "role",
  "effect",
  "effects",
  "response",
  "responses",
  "associated",
  "related",
  "involving",
]);

export type TokenMatchKind = "equal" | "existing-in-incoming";

/** Significant tokens of a concept title (stopwords and filler suffixes dropped). */
export function alignTokens(title: string): string[] {
  const stripped = title.replace(/\([^)]*\)/gu, " ");
  const parts = stripped
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{Letter}\p{Number}]+/u)
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (STOP.has(part) || part.length < 2) {
      continue;
    }
    if (seen.has(part)) {
      continue;
    }
    seen.add(part);
    out.push(part);
  }
  return out;
}

function isSubset(small: string[], large: Set<string>): boolean {
  return small.every((token) => large.has(token));
}

/**
 * Incoming title should reuse `existing` when token sets are equal, or when
 * the existing hub is broader/equal (its tokens are a subset of the incoming
 * title). One-token containment only counts when that token is long enough
 * and the incoming title is not much more specific.
 */
export function tokenMatch(existing: string[], incoming: string[]): TokenMatchKind | undefined {
  if (existing.length === 0 || incoming.length === 0) {
    return undefined;
  }
  const incomingSet = new Set(incoming);
  if (existing.length === incoming.length && isSubset(existing, incomingSet)) {
    return "equal";
  }
  if (!isSubset(existing, incomingSet)) {
    return undefined;
  }
  if (existing.length >= 2) {
    return "existing-in-incoming";
  }
  const only = existing[0] ?? "";
  if (only.length >= 5 && incoming.length - existing.length <= 2) {
    return "existing-in-incoming";
  }
  return undefined;
}

export function tokensEqual(left: string[], right: string[]): boolean {
  if (left.length === 0 || left.length !== right.length) {
    return false;
  }
  const other = new Set(right);
  return isSubset(left, other);
}
