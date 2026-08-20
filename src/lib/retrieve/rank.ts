import type { SearchHit } from "@/lib/index/search";

export const RRF_K = 60;

/** Reciprocal rank fusion. Rank is 0-based. Empty lists are ignored. */
export function reciprocalRankFusion(lists: SearchHit[][], k = RRF_K): SearchHit[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      if (!hit.id) {
        return;
      }
      scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
