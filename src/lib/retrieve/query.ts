import type { BundleIndex } from "@/lib/index/rebuild";
import { isGraphNode } from "@/lib/index/rebuild";
import type { SearchHit } from "@/lib/index/search";
import type { EmbeddingClient } from "@/lib/providers/types";
import { reciprocalRankFusion } from "@/lib/retrieve/rank";
import type { ConceptRecord } from "@/types/okf";

export type RetrieveQuery = {
  type?: string;
  publishedFrom?: string;
  publishedTo?: string;
  tags?: string[];
  text?: string;
  stableOnly?: boolean;
  vectorHits?: SearchHit[];
};

function inPublishedRange(published: string | undefined, from?: string, to?: string): boolean {
  if (!from && !to) {
    return true;
  }
  if (!published) {
    return false;
  }
  if (from && published < from) {
    return false;
  }
  if (to && published > to) {
    return false;
  }
  return true;
}

export async function queryVectorHits(
  index: BundleIndex,
  embed: EmbeddingClient | undefined,
  text: string,
): Promise<SearchHit[] | undefined> {
  if (!index.vectors || !embed || !text.trim()) {
    return undefined;
  }
  // Stored vectors were embedded with a different model; cosine similarity
  // across models is meaningless, so fall back to FTS-only retrieval.
  if (embed.model && index.vectors.model && embed.model !== index.vectors.model) {
    return undefined;
  }
  try {
    const [vector] = await embed.embed([text]);
    return vector ? index.vectors.search(vector) : undefined;
  } catch {
    return undefined;
  }
}

export function retrieve(index: BundleIndex, query: RetrieveQuery = {}): ConceptRecord[] {
  const stableOnly = query.stableOnly !== false;
  let ids: string[] | undefined;
  if (query.text && query.text.trim() !== "") {
    let ftsHits: SearchHit[] = [];
    try {
      ftsHits = index.search.search(query.text, { prefix: true, fuzzy: 0.2 });
    } catch {
      // MiniSearch can throw on empty/odd queries; keep FTS empty and use vectorHits if any.
    }
    const merged =
      query.vectorHits && query.vectorHits.length > 0
        ? reciprocalRankFusion([ftsHits, query.vectorHits])
        : ftsHits;
    ids = merged.map((hit) => hit.id);
  }

  const pool = ids
    ? ids.flatMap((id) => {
        const record = index.concepts.get(id);
        return record ? [record] : [];
      })
    : [...index.concepts.values()];

  return pool.filter((record) => {
    if (stableOnly && record.status !== "stable") {
      return false;
    }
    if (query.type && record.type !== query.type) {
      return false;
    }
    if (query.tags && query.tags.length > 0) {
      if (!query.tags.every((tag) => record.tags.includes(tag))) {
        return false;
      }
    }
    if (!inPublishedRange(record.published, query.publishedFrom, query.publishedTo)) {
      return false;
    }
    return true;
  });
}

export function walk(index: BundleIndex, startId: string, depth: number): ConceptRecord[] {
  const start = index.concepts.get(startId);
  if (!start) {
    return [];
  }
  const out: ConceptRecord[] = [];
  const seen = new Set<string>();
  const queue: { id: string; d: number }[] = [{ id: startId, d: 0 }];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next.id)) {
      continue;
    }
    seen.add(next.id);
    const record = index.concepts.get(next.id);
    if (!record) {
      continue;
    }
    out.push(record);
    if (next.d >= depth) {
      continue;
    }
    for (const child of record.outgoing) {
      if (!seen.has(child) && index.concepts.has(child)) {
        queue.push({ id: child, d: next.d + 1 });
      }
    }
  }
  return out.filter((record) => record.id === startId || isGraphNode(record));
}
