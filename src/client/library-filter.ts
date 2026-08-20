import type { GraphData, GraphNode } from "./graph-model.ts";
import { DEFAULT_GRAPH_TYPES } from "./graph-types.ts";

export type PaperLike = {
  id: string;
  title: string;
  published?: string;
  tags: string[];
};

export function filterPapers<T extends PaperLike>(
  papers: T[],
  query: string,
  from: string,
  to: string,
): T[] {
  const q = query.trim().toLowerCase();
  const start = from.trim();
  const end = to.trim();
  return papers.filter((paper) => {
    if (start || end) {
      if (!paper.published) {
        return false;
      }
      if (start && paper.published < start) {
        return false;
      }
      if (end && paper.published > end) {
        return false;
      }
    }
    if (!q) {
      return true;
    }
    if (paper.title.toLowerCase().includes(q) || paper.id.toLowerCase().includes(q)) {
      return true;
    }
    return paper.tags.some((tag) => tag.toLowerCase().includes(q));
  });
}

export function filterGraphData(
  graph: GraphData,
  options: {
    types: string[];
    query?: string;
    yearFrom?: string;
    yearTo?: string;
  },
): GraphData {
  const typeSet = new Set(options.types.length > 0 ? options.types : DEFAULT_GRAPH_TYPES);
  const query = options.query?.trim().toLowerCase() ?? "";
  const yearFrom = options.yearFrom?.trim();
  const yearTo = options.yearTo?.trim();
  const typed = graph.nodes.filter((node) => typeSet.has(node.type));
  const neighbors = undirectedNeighbors(graph.edges);
  let keep: GraphNode[];
  if (query) {
    const seeds = typed.filter((node) =>
      node.title.toLowerCase().includes(query) || node.id.toLowerCase().includes(query),
    );
    const ids = expand(seeds.map((node) => node.id), neighbors, 1);
    keep = typed.filter((node) => ids.has(node.id));
  } else if (yearFrom || yearTo) {
    const seeds = typed.filter((node) =>
      node.type === "Paper" && inYearRange(node.published, yearFrom, yearTo),
    );
    const ids = expand(seeds.map((node) => node.id), neighbors, 1);
    keep = typed.filter((node) => ids.has(node.id));
  } else {
    keep = typed;
  }
  const allowed = new Set(keep.map((node) => node.id));
  return {
    nodes: keep,
    edges: graph.edges.filter((edge) => allowed.has(edge.source) && allowed.has(edge.target)),
  };
}

function inYearRange(published: string | undefined, from?: string, to?: string): boolean {
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

function undirectedNeighbors(edges: GraphData["edges"]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const add = (from: string, to: string): void => {
    const list = map.get(from) ?? [];
    list.push(to);
    map.set(from, list);
  };
  for (const edge of edges) {
    add(edge.source, edge.target);
    add(edge.target, edge.source);
  }
  return map;
}

function expand(seeds: string[], neighbors: Map<string, string[]>, depth: number): Set<string> {
  const seen = new Set<string>();
  const queue: Array<{ id: string; d: number }> = seeds.map((id) => ({ id, d: 0 }));
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next.id)) {
      continue;
    }
    seen.add(next.id);
    if (next.d >= depth) {
      continue;
    }
    for (const id of neighbors.get(next.id) ?? []) {
      if (!seen.has(id)) {
        queue.push({ id, d: next.d + 1 });
      }
    }
  }
  return seen;
}
