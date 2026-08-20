/** One concept the graph can draw. Ghost targets have type "unknown". */
import { typeRank } from "./graph-types.ts";

export type GraphNode = {
  id: string;
  type: string;
  title: string;
  published?: string;
  tags?: string[];
  excerpt?: string;
};

export type GraphEdge = {
  source: string;
  target: string;
};

export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export const EMPTY_GRAPH: GraphData = { nodes: [], edges: [] };

export const GRAPH_NODE_CAP = 48;
export const GRAPH_EDGE_CAP = 80;

export function graphIsEmpty(graph: GraphData): boolean {
  return graph.nodes.length === 0;
}

/** Stable identity for a graph's topology (nodes + edges), independent of the
 * graph object identity, so topology-identical updates can be detected cheaply. */
export function graphSignature(graph: GraphData): string {
  return `${graph.nodes.map((node) => node.id).join("\u0001")}|${graph.edges
    .map((edge) => `${edge.source}->${edge.target}`)
    .join("\u0001")}`;
}

export function mergeGraphs(base: GraphData, extra: GraphData): GraphData {
  const nodes = new Map<string, GraphNode>();
  for (const node of base.nodes) {
    nodes.set(node.id, node);
  }
  for (const node of extra.nodes) {
    const current = nodes.get(node.id);
    nodes.set(node.id, current === undefined ? node : preferNode(current, node));
  }
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const edge of [...base.edges, ...extra.edges]) {
    const key = `${edge.source}->${edge.target}`;
    if (seen.has(key) || edge.source === edge.target) {
      continue;
    }
    seen.add(key);
    edges.push(edge);
  }
  return capGraph({ nodes: [...nodes.values()], edges });
}

export function graphFromSearch(body: Record<string, unknown>): GraphData {
  const hits = Array.isArray(body.hits) ? body.hits : [];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const hit of hits) {
    const node = asNamedNode(hit);
    if (node === null) {
      continue;
    }
    nodes.push(node);
    for (const target of asIdList((hit as Record<string, unknown>).outgoing)) {
      edges.push({ source: node.id, target });
      if (!nodes.some((item) => item.id === target)) {
        nodes.push(ghostNode(target));
      }
    }
  }
  return capGraph({ nodes, edges });
}

export function graphFromGet(body: Record<string, unknown>): GraphData {
  const id = asString(body.id);
  if (!id) {
    return EMPTY_GRAPH;
  }
  const title = asString(body.title) ?? id;
  const type = asString(body.type) ?? asString((body.frontmatter as Record<string, unknown> | undefined)?.type) ?? "unknown";
  const published = asString(body.published)
    ?? asString((body.frontmatter as Record<string, unknown> | undefined)?.published);
  const node: GraphNode = { id, type, title, ...(published ? { published } : {}) };
  const nodes: GraphNode[] = [node];
  const edges: GraphEdge[] = [];
  for (const target of asIdList(body.outgoing)) {
    edges.push({ source: id, target });
    nodes.push(ghostNode(target));
  }
  return capGraph({ nodes, edges });
}

export function graphFromCoverage(body: Record<string, unknown>): GraphData {
  const topics = Array.isArray(body.topics) ? body.topics : [];
  const nodes: GraphNode[] = [];
  for (const topic of topics) {
    const node = asNamedNode(topic);
    if (node !== null) {
      nodes.push({ ...node, type: node.type === "unknown" ? "Topic" : node.type });
    }
  }
  return capGraph({ nodes, edges: [] });
}

export function graphFromLibrary(body: Record<string, unknown>): GraphData {
  const nodes: GraphNode[] = [];
  if (Array.isArray(body.nodes)) {
    for (const item of body.nodes) {
      const node = asNamedNode(item);
      if (node !== null) {
        nodes.push(node);
      }
    }
  }
  const edges: GraphEdge[] = [];
  if (Array.isArray(body.edges)) {
    for (const item of body.edges) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const record = item as Record<string, unknown>;
      const source = asString(record.source);
      const target = asString(record.target);
      if (source && target && source !== target) {
        edges.push({ source, target });
      }
    }
  }
  return capGraph({ nodes, edges });
}

export function graphFromToolJson(name: string, body: Record<string, unknown>): GraphData {
  if (name === "okf_graph" || name === "okf_compare" || (Array.isArray(body.nodes) && Array.isArray(body.edges) && !Array.isArray(body.hits))) {
    return graphFromLibrary(body);
  }
  if (name === "okf_search" || Array.isArray(body.hits)) {
    return graphFromSearch(body);
  }
  if (name === "okf_coverage" || Array.isArray(body.topics)) {
    return graphFromCoverage(body);
  }
  if (name === "okf_get" || typeof body.id === "string") {
    return graphFromGet(body);
  }
  return EMPTY_GRAPH;
}

function capGraph(graph: GraphData): GraphData {
  const nodes = graph.nodes
    .slice()
    .sort((left, right) => typeRank(left.type) - typeRank(right.type) || left.id.localeCompare(right.id))
    .slice(0, GRAPH_NODE_CAP);
  const allowed = new Set(nodes.map((node) => node.id));
  const edges = graph.edges
    .filter((edge) => allowed.has(edge.source) && allowed.has(edge.target))
    .slice(0, GRAPH_EDGE_CAP);
  return { nodes, edges };
}

function preferNode(current: GraphNode, incoming: GraphNode): GraphNode {
  const type = current.type === "unknown" && incoming.type !== "unknown" ? incoming.type : current.type;
  const title = current.type === "unknown" && incoming.title !== incoming.id ? incoming.title : current.title;
  const published = incoming.published ?? current.published;
  const tags = incoming.tags ?? current.tags;
  const excerpt = incoming.excerpt ?? current.excerpt;
  return {
    id: current.id,
    type,
    title,
    ...(published ? { published } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(excerpt ? { excerpt } : {}),
  };
}

function asNamedNode(value: unknown): GraphNode | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = asString(record.id);
  if (!id) {
    return null;
  }
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "")
    : undefined;
  const excerpt = asString(record.excerpt);
  return {
    id,
    type: asString(record.type) ?? "unknown",
    title: asString(record.title) ?? id,
    ...(asString(record.published) ? { published: asString(record.published) } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(excerpt ? { excerpt } : {}),
  };
}

function ghostNode(id: string): GraphNode {
  const parts = id.split("/");
  return { id, type: "unknown", title: parts[parts.length - 1] || id };
}

function asIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "" || seen.has(item)) {
      continue;
    }
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
