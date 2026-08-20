import { isGraphNode, type BundleIndex } from "@/lib/index/rebuild";
import { DEFAULT_GRAPH_TYPES } from "@/lib/okf/concepts";
import { retrieve } from "@/lib/retrieve/query";
import type { ConceptRecord } from "@/types/okf";

/** Types shown by default (Dataset is on; Gene/Pathway are opt-in). */
export const GRAPH_TYPES: readonly string[] = DEFAULT_GRAPH_TYPES;
export const GRAPH_CLAIM_TYPE = "Claim";
/** Every toggleable graph type: overview types + Gene/Pathway + Claim. */
export const GRAPH_TYPE_FILTERS = [...GRAPH_TYPES, "Gene", "Pathway", GRAPH_CLAIM_TYPE] as const;
export const GRAPH_NODE_CAP = 180;
export const CLAIM_AUTO_HIDE = 40;
const AUTO_YEAR_WINDOW = 15;

export function claimCount(index: BundleIndex): number {
  let n = 0;
  for (const record of index.concepts.values()) {
    if (record.type === "Claim" && record.status !== "deprecated") {
      n += 1;
    }
  }
  return n;
}

export function defaultGraphTypes(index: BundleIndex): string[] {
  if (claimCount(index) >= CLAIM_AUTO_HIDE) {
    return [...GRAPH_TYPES];
  }
  return [...GRAPH_TYPES, GRAPH_CLAIM_TYPE];
}

export type GraphFilter = {
  types?: string[];
  yearFrom?: string;
  yearTo?: string;
  query?: string;
  depth?: number;
  maxNodes?: number;
  /** Drop Claim nodes whose undirected degree is below this (0 = keep all shown claims). */
  claimMinDegree?: number;
};

export type GraphFilterResult = {
  ids: Set<string>;
  total: number;
  shown: number;
  capped: boolean;
};

function inYearRange(published: string | undefined, from?: string, to?: string): boolean {
  if (!from && !to) {
    return true;
  }
  if (!published) {
    return false;
  }
  const year = published.slice(0, 4);
  if (from && year < from.slice(0, 4)) {
    return false;
  }
  if (to && year > to.slice(0, 4)) {
    return false;
  }
  return true;
}

function incomingMap(index: BundleIndex): Map<string, string[]> {
  const incoming = new Map<string, string[]>();
  for (const record of index.concepts.values()) {
    if (!isGraphNode(record)) {
      continue;
    }
    for (const target of record.outgoing) {
      const list = incoming.get(target) ?? [];
      list.push(record.id);
      incoming.set(target, list);
    }
  }
  return incoming;
}

export function undirectedNeighborhood(
  index: BundleIndex,
  seeds: string[],
  depth: number,
): Set<string> {
  const incoming = incomingMap(index);
  const seen = new Set<string>();
  const queue: { id: string; d: number }[] = seeds.map((id) => ({ id, d: 0 }));
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next.id)) {
      continue;
    }
    const record = index.concepts.get(next.id);
    if (!record || !isGraphNode(record)) {
      continue;
    }
    seen.add(next.id);
    if (next.d >= depth) {
      continue;
    }
    const neighbors = [...record.outgoing, ...(incoming.get(next.id) ?? [])];
    for (const id of neighbors) {
      if (!seen.has(id)) {
        queue.push({ id, d: next.d + 1 });
      }
    }
  }
  return seen;
}

function seedsFromQuery(index: BundleIndex, query: string): string[] {
  const hits = retrieve(index, { text: query, stableOnly: true });
  const seeds: string[] = [];
  const seen = new Set<string>();
  const add = (id: string | undefined): void => {
    if (!id || seen.has(id)) {
      return;
    }
    const record = index.concepts.get(id);
    if (!record || !isGraphNode(record)) {
      return;
    }
    seen.add(id);
    seeds.push(id);
  };
  for (const hit of hits) {
    if (isGraphNode(hit)) {
      add(hit.id);
    } else if (hit.paper) {
      add(hit.paper);
    }
  }
  return seeds;
}

function newestPapers(papers: ConceptRecord[], limit: number): ConceptRecord[] {
  return [...papers]
    .sort((a, b) => (b.published ?? "").localeCompare(a.published ?? ""))
    .slice(0, limit);
}

export function filterGraph(index: BundleIndex, filter: GraphFilter = {}): GraphFilterResult {
  const typeSet = new Set(filter.types?.length ? filter.types : defaultGraphTypes(index));
  const cap = filter.maxNodes ?? GRAPH_NODE_CAP;
  const allGraph = [...index.concepts.values()].filter(isGraphNode);
  const total = allGraph.length;
  const query = filter.query?.trim() ?? "";
  const yearFrom = filter.yearFrom?.trim() || undefined;
  const yearTo = filter.yearTo?.trim() || undefined;
  const minClaimDegree = filter.claimMinDegree ?? 0;
  const incoming = minClaimDegree > 0 ? incomingMap(index) : undefined;
  const typed = allGraph.filter((record) => {
    if (!typeSet.has(record.type)) {
      return false;
    }
    if (minClaimDegree > 0 && record.type === GRAPH_CLAIM_TYPE && incoming) {
      const degree = record.outgoing.length + (incoming.get(record.id)?.length ?? 0);
      return degree >= minClaimDegree;
    }
    return true;
  });
  const unfiltered = !query && !yearFrom && !yearTo && typed.length <= cap;

  if (unfiltered) {
    return { ids: new Set(typed.map((record) => record.id)), total, shown: typed.length, capped: false };
  }

  let seeds: string[];
  if (query) {
    seeds = seedsFromQuery(index, query);
  } else {
    let papers = allGraph.filter(
      (record) => record.type === "Paper" && inYearRange(record.published, yearFrom, yearTo),
    );
    if (!yearFrom && !yearTo && papers.length > 80) {
      const cutoff = String(new Date().getFullYear() - AUTO_YEAR_WINDOW);
      const recent = papers.filter((paper) => (paper.published?.slice(0, 4) ?? "") >= cutoff);
      papers = recent.length > 0 ? recent : newestPapers(papers, 80);
    }
    seeds = papers.map((paper) => paper.id);
  }

  const expanded = undirectedNeighborhood(index, seeds, filter.depth ?? 1);
  let ids = [...expanded].filter((id) => {
    const record = index.concepts.get(id);
    return record && isGraphNode(record) && typeSet.has(record.type);
  });
  if (minClaimDegree > 0 && incoming) {
    ids = ids.filter((id) => {
      const record = index.concepts.get(id);
      if (record?.type !== GRAPH_CLAIM_TYPE) {
        return true;
      }
      const degree = record.outgoing.length + (incoming.get(id)?.length ?? 0);
      return degree >= minClaimDegree;
    });
  }

  let capped = false;
  if (ids.length > cap && !query) {
    capped = true;
    const papers = ids
      .map((id) => index.concepts.get(id))
      .filter((record): record is ConceptRecord => record?.type === "Paper");
    const keptPapers = newestPapers(papers, Math.min(80, cap));
    const neighborhood = undirectedNeighborhood(
      index,
      keptPapers.map((paper) => paper.id),
      1,
    );
    ids = [...neighborhood].filter((id) => {
      const record = index.concepts.get(id);
      if (!record || !isGraphNode(record) || !typeSet.has(record.type)) {
        return false;
      }
      if (minClaimDegree > 0 && incoming && record.type === GRAPH_CLAIM_TYPE) {
        const degree = record.outgoing.length + (incoming.get(id)?.length ?? 0);
        return degree >= minClaimDegree;
      }
      return true;
    });
    if (ids.length > cap) {
      ids = ids.slice(0, cap);
    }
  }

  return { ids: new Set(ids), total, shown: ids.length, capped };
}
