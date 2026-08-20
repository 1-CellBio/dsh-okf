import type { GraphData, GraphNode } from "./graph-model.ts";
import { GRAPH_COLUMNS } from "./graph-types.ts";

export type LaidOutNode = {
  id: string;
  type: string;
  label: string;
  title: string;
  published?: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type LaidOutEdge = {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type GraphLayout = {
  width: number;
  height: number;
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
};

const COL_GAP = 148;
const ROW_GAP = 40;
const NODE_W = 124;
const NODE_H = 28;
const PAD = 16;

/** Deterministic type-column layout. No cytoscape; positions are stable across rerenders. */
export function layoutGraph(graph: GraphData): GraphLayout {
  const buckets = new Map<string, GraphNode[]>();
  for (const column of GRAPH_COLUMNS) {
    buckets.set(column, []);
  }
  for (const node of graph.nodes) {
    const column = (GRAPH_COLUMNS as readonly string[]).includes(node.type) ? node.type : "unknown";
    buckets.get(column)?.push(node);
  }
  const used = GRAPH_COLUMNS.filter((column) => (buckets.get(column)?.length ?? 0) > 0);
  const placed = new Map<string, LaidOutNode>();
  let maxRow = 0;
  used.forEach((column, colIndex) => {
    const items = buckets.get(column) ?? [];
    items.forEach((node, row) => {
      maxRow = Math.max(maxRow, row + 1);
      placed.set(node.id, {
        id: node.id,
        type: node.type,
        title: node.title,
        label: shortLabel(node.title, node.type),
        ...(node.published ? { published: node.published } : {}),
        x: PAD + colIndex * COL_GAP,
        y: PAD + row * ROW_GAP,
        w: NODE_W,
        h: NODE_H,
      });
    });
  });
  const nodes = [...placed.values()];
  const edges: LaidOutEdge[] = [];
  for (const edge of graph.edges) {
    const from = placed.get(edge.source);
    const to = placed.get(edge.target);
    if (from === undefined || to === undefined) {
      continue;
    }
    edges.push({
      id: `${edge.source}->${edge.target}`,
      x1: from.x + from.w,
      y1: from.y + from.h / 2,
      x2: to.x,
      y2: to.y + to.h / 2,
    });
  }
  return {
    width: Math.max(PAD * 2 + NODE_W, PAD * 2 + Math.max(used.length, 1) * COL_GAP - (COL_GAP - NODE_W)),
    height: Math.max(PAD * 2 + NODE_H, PAD * 2 + Math.max(maxRow, 1) * ROW_GAP - (ROW_GAP - NODE_H)),
    nodes,
    edges,
  };
}

export const NODE_SIZE = 18;
const FORCE_PAD = 40;
const MIN_SEP = 28;

function targetSpan(count: number): number {
  return Math.min(720, Math.max(240, Math.ceil(Math.sqrt(count) * 36)));
}

/**
 * Compact circular layout. The canvas grows with node count so 18px dots
 * stay separate when claims are turned on.
 */
export function layoutForceGraph(graph: GraphData, salt = 0): GraphLayout {
  const count = Math.max(graph.nodes.length, 1);
  const ring = 48 + Math.sqrt(count) * 22;
  const twist = salt * 0.41;
  const bodies = graph.nodes.map((node) => {
    const typeBias = ((GRAPH_COLUMNS as readonly string[]).indexOf(node.type) + 1) * 0.35;
    // Angle is hashed from the node id, not derived from the array index, so a
    // node keeps a stable starting position when other nodes are added/removed
    // or reordered (e.g. a ghost node's type resolving to "Paper").
    const angle = 2 * Math.PI * hash01(node.id) + typeBias + twist;
    const radius = ring * (0.65 + hash01(`${salt}:${node.id}`) * 0.35);
    return {
      id: node.id,
      type: node.type,
      title: node.title,
      label: shortLabel(node.title, node.type),
      ...(node.published ? { published: node.published } : {}),
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      w: NODE_SIZE,
      h: NODE_SIZE,
    };
  });
  const index = new Map(bodies.map((body, i) => [body.id, i]));
  const links: Array<{ from: number; to: number }> = [];
  for (const edge of graph.edges) {
    const from = index.get(edge.source);
    const to = index.get(edge.target);
    if (from === undefined || to === undefined || from === to) {
      continue;
    }
    links.push({ from, to });
  }
  const ticks = Math.min(80, 36 + Math.floor(Math.sqrt(count) * 5));
  const gravity = Math.max(0.012, 0.07 - count / 3500);
  const rest = 40 + Math.min(24, Math.sqrt(count));
  for (let tick = 0; tick < ticks; tick += 1) {
    for (let i = 0; i < bodies.length; i += 1) {
      for (let j = i + 1; j < bodies.length; j += 1) {
        const a = bodies[i];
        const b = bodies[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          dx = 0.35;
          dy = 0.2;
          dist = 0.4;
        }
        const force = dist < MIN_SEP ? (MIN_SEP - dist) * 0.85 : 220 / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }
    for (const link of links) {
      const a = bodies[link.from];
      const b = bodies[link.to];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(Math.hypot(dx, dy), 0.01);
      const pull = (dist - rest) * 0.1;
      const fx = (dx / dist) * pull;
      const fy = (dy / dist) * pull;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
    let cx = 0;
    let cy = 0;
    for (const body of bodies) {
      cx += body.x;
      cy += body.y;
    }
    cx /= count;
    cy /= count;
    for (const body of bodies) {
      body.vx += (cx - body.x) * gravity;
      body.vy += (cy - body.y) * gravity;
      body.vx *= 0.72;
      body.vy *= 0.72;
      body.x += body.vx;
      body.y += body.vy;
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const body of bodies) {
    minX = Math.min(minX, body.x);
    minY = Math.min(minY, body.y);
    maxX = Math.max(maxX, body.x);
    maxY = Math.max(maxY, body.y);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const scale = targetSpan(count) / span;
  const placed = new Map<string, LaidOutNode>();
  for (const body of bodies) {
    placed.set(body.id, {
      id: body.id,
      type: body.type,
      title: body.title,
      label: body.label,
      ...(body.published ? { published: body.published } : {}),
      x: (body.x - minX) * scale + FORCE_PAD,
      y: (body.y - minY) * scale + FORCE_PAD,
      w: NODE_SIZE,
      h: NODE_SIZE,
    });
  }
  return {
    width: (maxX - minX) * scale + FORCE_PAD * 2,
    height: (maxY - minY) * scale + FORCE_PAD * 2,
    nodes: [...placed.values()],
    edges: layoutEdges(graph.edges, placed),
  };
}

export function layoutEdges(
  edges: GraphData["edges"],
  placed: Map<string, Pick<LaidOutNode, "x" | "y">>,
): LaidOutEdge[] {
  const radius = NODE_SIZE / 2;
  const out: LaidOutEdge[] = [];
  for (const edge of edges) {
    const from = placed.get(edge.source);
    const to = placed.get(edge.target);
    if (from === undefined || to === undefined) {
      continue;
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.max(Math.hypot(dx, dy), 0.01);
    const ux = dx / dist;
    const uy = dy / dist;
    out.push({
      id: `${edge.source}->${edge.target}`,
      x1: from.x + ux * radius,
      y1: from.y + uy * radius,
      x2: to.x - ux * (radius + 4),
      y2: to.y - uy * (radius + 4),
    });
  }
  return out;
}

export function shortLabel(title: string, type: string): string {
  let base = title.trim();
  if (type === "Paper") {
    const head = base.split(/[:：]/)[0]?.trim();
    if (head) {
      base = head;
    }
  }
  const max = type === "Paper" ? 22 : 18;
  if (base.length <= max) {
    return base;
  }
  return `${base.slice(0, max).trimEnd()}…`;
}

function hash01(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

