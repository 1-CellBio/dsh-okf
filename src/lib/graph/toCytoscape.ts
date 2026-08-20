import { isGraphNode, type BundleIndex } from "@/lib/index/rebuild";

export type GraphNode = {
  data: { id: string; label: string; shortLabel: string; type: string };
};

export type GraphEdge = {
  data: { id: string; source: string; target: string };
};

export type GraphElements = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export function shortGraphLabel(title: string, type: string): string {
  let base = title.trim();
  if (type === "Paper") {
    const head = base.split(/[:：]/)[0]?.trim();
    if (head) {
      base = head;
    }
  }
  const max = type === "Paper" ? 32 : 24;
  if (base.length <= max) {
    return base;
  }
  return `${base.slice(0, max).trimEnd()}…`;
}

export function toCytoscape(index: BundleIndex, allowedIds?: Set<string>): GraphElements {
  const nodes: GraphNode[] = [];
  const ids = new Set<string>();

  for (const record of index.concepts.values()) {
    if (!isGraphNode(record)) {
      continue;
    }
    if (allowedIds && !allowedIds.has(record.id)) {
      continue;
    }
    ids.add(record.id);
    const label = record.title ?? record.id;
    nodes.push({
      data: {
        id: record.id,
        label,
        shortLabel: shortGraphLabel(label, record.type),
        type: record.type,
      },
    });
  }

  const edges: GraphEdge[] = [];
  for (const record of index.concepts.values()) {
    if (!ids.has(record.id)) {
      continue;
    }
    for (const target of record.outgoing) {
      if (!ids.has(target)) {
        continue;
      }
      edges.push({
        data: {
          id: `${record.id}->${target}`,
          source: record.id,
          target,
        },
      });
    }
  }

  return { nodes, edges };
}

export { GRAPH_COLORS, GRAPH_COLOR_VARS, paintForCanvas, resolveGraphColors } from "./colors";

export const GRAPH_TYPE_LABELS: Record<string, string> = {
  Paper: "论文",
  Topic: "主题",
  Method: "方法",
  Entity: "实体",
  Dataset: "数据集",
  Gene: "基因",
  Pathway: "通路",
  Claim: "主张",
};
