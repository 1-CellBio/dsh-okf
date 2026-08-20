import { normalizeAlignKey } from "@/lib/compile/align";
import { publishedYear } from "@/lib/okf/slug";
import type { BiblioHit, BiblioLookup } from "./types";

export const BIBLIO_HIGH_CONFIDENCE = 0.85;

function tokens(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFKC")
      .toLowerCase()
      .split(/[^\p{Letter}\p{Number}]+/u)
      .filter((part) => part.length > 1),
  );
}

export function titleOverlap(a: string, b: string): number {
  if (normalizeAlignKey(a) === normalizeAlignKey(b)) {
    return 1;
  }
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const token of left) {
    if (right.has(token)) {
      inter += 1;
    }
  }
  return inter / (left.size + right.size - inter);
}

export function yearsMatch(queryYear?: string, published?: string): boolean {
  if (!queryYear) {
    return true;
  }
  const hitYear = published ? publishedYear(published) : undefined;
  return !hitYear || hitYear === queryYear;
}

/** Score a catalog hit against the compile query. DOI lookups should pass score 1 from the client. */
export function scoreBiblioHit(query: BiblioLookup, hit: Omit<BiblioHit, "score">): number {
  if (query.doi && hit.doi && query.doi.toLowerCase() === hit.doi.toLowerCase()) {
    return 1;
  }
  const title = query.title?.trim();
  if (!title || !hit.title) {
    return 0;
  }
  const overlap = titleOverlap(title, hit.title);
  const yearOk = yearsMatch(query.year, hit.published);
  if (overlap >= 0.999 && yearOk) {
    return 0.95;
  }
  if (overlap >= 0.8 && yearOk) {
    return 0.88;
  }
  if (yearOk && overlap >= 0.5) {
    return 0.55;
  }
  if (!yearOk) {
    return Math.min(overlap, 0.4);
  }
  return overlap;
}

export function isHighConfidence(score: number): boolean {
  return score >= BIBLIO_HIGH_CONFIDENCE;
}
