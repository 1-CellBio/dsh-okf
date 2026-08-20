import type { GraphData, GraphNode } from "./graph-model.ts";
import { NODE_TYPE_ORDER } from "./graph-types.ts";

export type InspectNeighbor = {
  id: string;
  title: string;
  type: string;
  direction: "out" | "in" | "both";
};

export type InspectedNode = {
  id: string;
  title: string;
  type: string;
  published?: string;
  tags: string[];
  excerpt: string;
  neighbors: InspectNeighbor[];
};

export function inspectGraphNode(graph: GraphData, id: string): InspectedNode | null {
  // One id→node map instead of a linear nodes.find per edge, keeping the
  // whole scan O(V+E) so the neighbor-filter input stays responsive when
  // users raise the node cap on large libraries.
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const node = byId.get(id);
  if (!node) {
    return null;
  }
  const outgoing: InspectNeighbor[] = [];
  const incoming: InspectNeighbor[] = [];
  for (const edge of graph.edges) {
    if (edge.source === id) {
      const target = byId.get(edge.target);
      if (target) {
        outgoing.push({ ...ref(target), direction: "out" });
      }
    }
    if (edge.target === id) {
      const source = byId.get(edge.source);
      if (source) {
        incoming.push({ ...ref(source), direction: "in" });
      }
    }
  }
  const merged = new Map<string, InspectNeighbor>();
  for (const item of outgoing) {
    merged.set(item.id, item);
  }
  for (const item of incoming) {
    const current = merged.get(item.id);
    if (current) {
      current.direction = "both";
    } else {
      merged.set(item.id, item);
    }
  }
  const neighbors = [...merged.values()].sort((left, right) =>
    typeRank(left.type) - typeRank(right.type) || left.title.localeCompare(right.title),
  );
  return {
    id: node.id,
    title: node.title,
    type: node.type,
    tags: node.tags ?? [],
    excerpt: node.excerpt ?? "",
    neighbors,
    ...(node.published ? { published: node.published } : {}),
  };
}

function ref(node: GraphNode): Omit<InspectNeighbor, "direction"> {
  return { id: node.id, title: node.title, type: node.type };
}

export function fileName(id: string): string {
  const parts = id.split("/");
  return parts[parts.length - 1] || id;
}

const TYPE_ORDER = NODE_TYPE_ORDER;

export const DIRECTION_MARK: Record<InspectNeighbor["direction"], string> = {
  out: "→",
  in: "←",
  both: "↔",
};

export const DIRECTION_LABEL: Record<InspectNeighbor["direction"], string> = {
  out: "指出",
  in: "被引用",
  both: "双向",
};

export function groupInspectNeighbors(
  items: InspectNeighbor[],
): Array<{ type: string; items: InspectNeighbor[] }> {
  const groups = new Map<string, InspectNeighbor[]>();
  for (const item of items) {
    const list = groups.get(item.type) ?? [];
    list.push(item);
    groups.set(item.type, list);
  }
  return [...groups.entries()]
    .sort((left, right) => typeRank(left[0]) - typeRank(right[0]))
    .map(([type, grouped]) => ({ type, items: grouped }));
}

function typeRank(type: string): number {
  const index = TYPE_ORDER.indexOf(type);
  return index === -1 ? TYPE_ORDER.length : index;
}
