import { useEffect, useRef, useState } from "react";
import Sigma from "sigma";
import { EdgeArrowProgram } from "sigma/rendering";
import type { EdgeDisplayData, NodeDisplayData } from "sigma/types";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type { ForceAtlas2Settings } from "graphology-layout-forceatlas2";
import FA2LayoutSupervisor from "graphology-layout-forceatlas2/worker";
import { createNodeBorderProgram } from "@sigma/node-border";
import { fitViewportToNodes } from "@sigma/utils";
import { graphSignature, type GraphData, type GraphNode } from "./graph-model.ts";
import type { OkfLocaleKey } from "./locales.ts";
import { readPaint, resolvePluginGraphColors } from "./paint.ts";
import css from "./GraphCanvas.module.css";

export type GraphNetworkProps = {
  graph: GraphData;
  showLabels?: boolean;
  selectedId?: string | null;
  emptyLabel: string;
  fitLabel?: string;
  relayoutLabel?: string;
  focusNonce?: number;
  onSelect?: (id: string | null) => void;
  t?: (key: OkfLocaleKey) => string;
};

type Fa2Controls = {
  gravity: number;
  scalingRatio: number;
  slowDown: number;
  linLogMode: boolean;
  strongGravityMode: boolean;
  outboundAttractionDistribution: boolean;
  adjustSizes: boolean;
  barnesHutOptimize: boolean;
};

type LayoutApi = {
  start: (reseed: boolean) => void;
  stop: () => void;
  apply: (controls: Fa2Controls, reseed: boolean) => void;
};

type Fa2Supervisor = FA2LayoutSupervisor & { settings: ForceAtlas2Settings };

function liveSteps(order: number): number {
  if (order > 4000) {
    return 1;
  }
  if (order > 1200) {
    return 2;
  }
  if (order > 400) {
    return 3;
  }
  return 5;
}

/** Hard cap per Run. 2000 is enough for a few hundred nodes; 1000-paper
 * graphs can hit it — click Run again to continue from the current positions. */
const FA2_MAX_ITERATIONS = 2000;
/** Skip settle checks while the layout is still exploding off the seed ring. */
const FA2_WARMUP = 120;
const FA2_SAMPLE_EVERY = 15;
const FA2_STABLE_WINDOWS = 4;
/** Mean node travel / graph extent. ~1px on a 1000-unit layout. */
const FA2_SETTLE_RATIO = 0.0012;

type LayoutHalt = "user" | "settled" | "cap";

function snapshotPositions(graph: Graph): Map<string, { x: number; y: number }> {
  const next = new Map<string, { x: number; y: number }>();
  graph.forEachNode((node, attr) => {
    const x = Number(attr.x);
    const y = Number(attr.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      next.set(node, { x, y });
    }
  });
  return next;
}

/** RMS displacement since `previous`, scaled by the current bbox. */
function moveRatio(graph: Graph, previous: Map<string, { x: number; y: number }> | null): number {
  if (!previous || previous.size === 0) {
    return 1;
  }
  let sum = 0;
  let n = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  graph.forEachNode((node, attr) => {
    const x = Number(attr.x);
    const y = Number(attr.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    const prev = previous.get(node);
    if (!prev) {
      return;
    }
    const dx = x - prev.x;
    const dy = y - prev.y;
    sum += dx * dx + dy * dy;
    n += 1;
  });
  if (n === 0) {
    return 1;
  }
  const extent = Math.max(maxX - minX, maxY - minY, 1);
  return Math.sqrt(sum / n) / extent;
}

type HoverTip = {
  x: number;
  y: number;
  title: string;
  type: string;
};

/** nodeReducer return value: the border ring is not part of NodeDisplayData, so
 * it is declared as extra attributes the border program reads from. */
type NodeDisplayLike = Partial<NodeDisplayData> & {
  borderColor: string;
  borderSize: number;
};

type EdgeDisplayLike = Partial<EdgeDisplayData>;

const ARROWS_UNTIL = 1500;
const HIDE_EDGES_ON_MOVE_AFTER = 2000;
// Mix amount toward the canvas when a node is not in the hover/selection
// neighborhood. Sigma's WebGL programs blend with premultiplied alpha, so a
// raw `rgba(..., 0.14)` fill washes out to opaque white on a light background.
const FADE_MIX = 0.52;
// Pixel travel before a node mousedown counts as a drag (not a click).
const DRAG_TOLERANCE_PX = 4;
const RING_SIZE = 0.16;
const RING_FOCUS = 0.28;
const EDGE_SIZE = 0.4;
const EDGE_SIZE_HOVER = 1.4;

// Outer ring + filled disc. The previous program listed only a 0px border and
// no fill, so WebGL drew empty nodes and the graph collapsed to a grey
// hairball of edges. Fill must be an explicit `{ size: { fill: true } }` layer.
const borderProgram = createNodeBorderProgram({
  borders: [
    {
      color: { attribute: "borderColor", defaultValue: "#ffffff" },
      size: { attribute: "borderSize", defaultValue: RING_SIZE },
    },
    {
      color: { attribute: "color" },
      size: { fill: true },
    },
  ],
});

/** Gephi / graphology inferSettings, exposed as live sliders. Each Run is
 * capped at FA2_MAX_ITERATIONS and also stops when node motion settles. */
function defaultFa2(order: number): Fa2Controls {
  const inferred = forceAtlas2.inferSettings(Math.max(2, order));
  return {
    gravity: inferred.gravity ?? 0.05,
    scalingRatio: inferred.scalingRatio ?? 10,
    // Infer uses ~1+log(n), which freezes a settled graph so hard that Run
    // looks like a no-op. Keep a Gephi-like range so Play stays visible.
    slowDown: Math.max(1, Math.min(4, inferred.slowDown ?? 1 + Math.log(Math.max(2, order)) * 0.45)),
    linLogMode: false,
    strongGravityMode: inferred.strongGravityMode ?? true,
    outboundAttractionDistribution: false,
    adjustSizes: false,
    barnesHutOptimize: inferred.barnesHutOptimize ?? order > 2000,
  };
}

function toFa2Settings(controls: Fa2Controls): ForceAtlas2Settings {
  return {
    linLogMode: controls.linLogMode,
    outboundAttractionDistribution: controls.outboundAttractionDistribution,
    adjustSizes: controls.adjustSizes,
    edgeWeightInfluence: 0,
    scalingRatio: controls.scalingRatio,
    strongGravityMode: controls.strongGravityMode,
    gravity: controls.gravity,
    slowDown: controls.slowDown,
    barnesHutOptimize: controls.barnesHutOptimize,
    barnesHutTheta: 0.5,
  };
}

function nodeSize(node: GraphNode, degree: number, order: number): number {
  const scale = order > 2000 ? 0.5 : order > 800 ? 0.68 : 0.85;
  const base = (node.type === "Paper" ? 8 : 6.2) * scale;
  return base + Math.min(5, Math.log2(1 + degree) * 1.3) * scale;
}

function parseRgb(color: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/i.exec(color);
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  return null;
}

/** Mix `color` toward `toward` (canvas) so faded nodes keep their type hue. */
function fadeToward(color: string, toward: string, amount: number): string {
  const src = parseRgb(color);
  const dst = parseRgb(toward) ?? [255, 255, 255];
  if (!src) {
    return color;
  }
  const t = Math.max(0, Math.min(1, amount));
  const mix = (a: number, b: number) => Math.round(a * (1 - t) + b * t);
  return `rgb(${mix(src[0], dst[0])}, ${mix(src[1], dst[1])}, ${mix(src[2], dst[2])})`;
}

/** Ring start: a jittered circle is a better FA2 seed than a random cloud
 * (and avoids the all-zero origin edge case the algorithm cannot solve). */
function scatter(graph: Graph): void {
  const n = Math.max(1, graph.order);
  const radius = Math.max(80, Math.sqrt(n) * 28);
  let i = 0;
  graph.forEachNode((node) => {
    const angle = (2 * Math.PI * i) / n + (Math.random() - 0.5) * 0.35;
    const r = radius * (0.85 + Math.random() * 0.3);
    graph.setNodeAttribute(node, "x", Math.cos(angle) * r);
    graph.setNodeAttribute(node, "y", Math.sin(angle) * r);
    i += 1;
  });
}

function fillGraph(
  graph: Graph,
  data: GraphData,
  colors: Record<string, string>,
  edgeColor: string,
  outline: string,
): void {
  const degrees = new Map<string, number>();
  for (const edge of data.edges) {
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
  }
  // Sigma v3 validates every node's x/y as soon as it sees the graph (both at
  // `new Sigma()` and on later nodeAdded events), so positions must exist at
  // creation time — runLayout re-scatters before actually laying out.
  const n = Math.max(1, data.nodes.length);
  const radius = Math.max(80, Math.sqrt(n) * 28);
  let i = 0;
  for (const node of data.nodes) {
    if (graph.hasNode(node.id)) {
      continue;
    }
    const angle = (2 * Math.PI * i) / n;
    graph.addNode(node.id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      title: node.title,
      nodeType: node.type,
      label: shortGraphLabel(node.title, node.type),
      color: colors[node.type] ?? edgeColor,
      borderColor: outline,
      borderSize: RING_SIZE,
      size: nodeSize(node, degrees.get(node.id) ?? 0, n),
      zIndex: node.type === "Paper" ? 2 : 1,
    });
    i += 1;
  }
  const stroke = fadeToward(edgeColor, outline, n > ARROWS_UNTIL ? 0.4 : 0.22);
  const edgeType = n > ARROWS_UNTIL ? "line" : "arrow";
  for (const edge of data.edges) {
    if (edge.source === edge.target || !graph.hasNode(edge.source) || !graph.hasNode(edge.target)) {
      continue;
    }
    graph.mergeDirectedEdge(edge.source, edge.target, {
      type: edgeType,
      color: stroke,
      size: EDGE_SIZE,
    });
  }
}

/** If FA2 produces non-finite coords, re-seed. If it explodes, scale the whole
 * layout down instead of clamping each axis independently (that clamp used to
 * squash the graph into a square hairball). */
function sanitizePositions(graph: Graph): void {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let bad = false;
  graph.forEachNode((node) => {
    const x = Number(graph.getNodeAttribute(node, "x"));
    const y = Number(graph.getNodeAttribute(node, "y"));
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      bad = true;
      return;
    }
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  });
  if (bad || !Number.isFinite(minX)) {
    scatter(graph);
    return;
  }
  const extent = Math.max(maxX - minX, maxY - minY);
  const target = 900;
  if (extent < 8 || extent > target * 6) {
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const scale = extent < 8 ? target / 80 : target / extent;
    graph.forEachNode((node) => {
      const x = Number(graph.getNodeAttribute(node, "x"));
      const y = Number(graph.getNodeAttribute(node, "y"));
      graph.setNodeAttribute(node, "x", (x - cx) * scale);
      graph.setNodeAttribute(node, "y", (y - cy) * scale);
    });
  }
}

/** Push overlapping discs apart so type-colored nodes stay readable. Pairwise
 * for the 1000-paper overview (≤2.5k); skipped above that so layout stays cheap. */
function preventOverlap(graph: Graph): void {
  const nodes = graph.nodes();
  const n = nodes.length;
  if (n < 2 || n > 2500) {
    return;
  }
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const sizes = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    xs[i] = Number(graph.getNodeAttribute(nodes[i]!, "x"));
    ys[i] = Number(graph.getNodeAttribute(nodes[i]!, "y"));
    sizes[i] = Number(graph.getNodeAttribute(nodes[i]!, "size")) || 6;
  }
  const padding = 1.85;
  const rounds = n > 800 ? 6 : 14;
  for (let round = 0; round < rounds; round += 1) {
    let moved = false;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const dx = xs[j]! - xs[i]!;
        const dy = ys[j]! - ys[i]!;
        const dist = Math.hypot(dx, dy) || 0.01;
        const min = (sizes[i]! + sizes[j]!) * padding;
        if (dist >= min) {
          continue;
        }
        const push = (min - dist) / 2;
        const ux = dx / dist;
        const uy = dy / dist;
        xs[i]! -= ux * push;
        ys[i]! -= uy * push;
        xs[j]! += ux * push;
        ys[j]! += uy * push;
        moved = true;
      }
    }
    if (!moved) {
      break;
    }
  }
  for (let i = 0; i < n; i += 1) {
    graph.setNodeAttribute(nodes[i]!, "x", xs[i]!);
    graph.setNodeAttribute(nodes[i]!, "y", ys[i]!);
  }
}

function fitToGraph(sigma: Sigma, animate: boolean, nodeIds?: string[]): void {
  const nodes = nodeIds ?? sigma.getGraph().nodes();
  void fitViewportToNodes(sigma, nodes, { animate }).finally(() => {
    sigma.refresh();
  });
}

/** Gephi-Lite-style graph: sigma.js WebGL + graphology ForceAtlas2 that the
 * user starts/stops, with live sliders and node dragging. */
export function GraphNetwork(props: GraphNetworkProps) {
  const {
    graph: graphData,
    showLabels,
    selectedId = null,
    emptyLabel,
    fitLabel,
    relayoutLabel,
    focusNonce,
    onSelect,
    t,
  } = props;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const supervisorRef = useRef<FA2LayoutSupervisor | null>(null);
  const layoutApiRef = useRef<LayoutApi | null>(null);
  const settingsRef = useRef<Fa2Controls>(defaultFa2(graphData.nodes.length));
  const graphSigRef = useRef("");
  const onSelectRef = useRef(onSelect);
  const colorsRef = useRef<Record<string, string>>({});
  const edgeColorRef = useRef("#888");
  const labelColorRef = useRef("#000");
  const outlineColorRef = useRef("#fff");
  const keptRef = useRef<Set<string>>(new Set());
  const hoveredRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const dragRef = useRef<{
    id: string;
    moved: boolean;
    x: number;
    y: number;
  } | null>(null);
  const pinnedRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const runningRef = useRef(false);
  const suppressClickRef = useRef(false);
  const [tip, setTip] = useState<HoverTip | null>(null);
  const [running, setRunning] = useState(false);
  const [layoutSteps, setLayoutSteps] = useState(0);
  const [layoutHalt, setLayoutHalt] = useState<LayoutHalt | null>(null);
  const [dragging, setDragging] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [fa2, setFa2] = useState<Fa2Controls>(() => defaultFa2(graphData.nodes.length));
  settingsRef.current = fa2;

  const label = (key: OkfLocaleKey, fallback: string): string => t?.(key) ?? fallback;

  useEffect(() => {
    onSelectRef.current = onSelect;
  });

  const hasNodes = graphData.nodes.length > 0;

  // Instance lifecycle: create the graphology graph + sigma instance once when
  // the container appears, destroy only on unmount or when the graph becomes
  // empty. The instance is deliberately NOT tied to the `graph` identity, so
  // topology-identical updates keep the same instance, its layout and camera.
  useEffect(() => {
    const container = containerRef.current;
    const wrap = wrapRef.current;
    if (!container || !wrap || !hasNodes) {
      return;
    }
    const colors = resolvePluginGraphColors(wrap);
    const labelColor = readPaint(wrap, "--dsw-alias-label-primary", "oklch(0.145 0 0)");
    const outline = readPaint(wrap, "--dsw-alias-bg-layer-1", "oklch(1 0 0)");
    const edge = readPaint(wrap, "--dsw-alias-label-tertiary", "oklch(0.556 0 0)");
    colorsRef.current = colors;
    edgeColorRef.current = edge;
    labelColorRef.current = labelColor;
    outlineColorRef.current = outline;

    const graph = new Graph({ type: "directed", allowSelfLoops: false });
    fillGraph(graph, graphData, colors, edge, outline);

    const sigma = new Sigma(graph, container, {
      allowInvalidContainer: true,
      minCameraRatio: 0.05,
      maxCameraRatio: 4,
      autoCenter: false,
      zIndex: true,
      renderLabels: Boolean(showLabels),
      labelColor: { color: labelColor },
      labelSize: 11,
      labelWeight: "500",
      labelRenderedSizeThreshold: 8,
      // Sigma's default hover draws a second pill label; we already show a
      // tooltip, so skip that canvas overlay.
      defaultDrawNodeHover: () => undefined,
      minEdgeThickness: 0.35,
      defaultEdgeType: graph.order > ARROWS_UNTIL ? "line" : "arrow",
      nodeProgramClasses: { circle: borderProgram },
      edgeProgramClasses: { arrow: EdgeArrowProgram },
      nodeReducer: (node, data) => {
        const kept = keptRef.current;
        const dimmed = kept.size > 0 && !kept.has(node);
        const focused = node === hoveredRef.current || node === selectedRef.current;
        const fill = String(data.color);
        const canvas = outlineColorRef.current;
        return {
          ...data,
          color: dimmed ? fadeToward(fill, canvas, FADE_MIX) : fill,
          size: focused ? Number(data.size) * 1.35 : data.size,
          borderSize: focused ? RING_FOCUS : RING_SIZE,
          borderColor: dimmed
            ? fadeToward(fill, canvas, 0.72)
            : focused
              ? labelColorRef.current
              : canvas,
          zIndex: focused ? 4 : Number(data.zIndex ?? 1),
        } satisfies NodeDisplayLike;
      },
      edgeReducer: (edge, data) => {
        const kept = keptRef.current;
        if (kept.size === 0) {
          return { ...data, size: EDGE_SIZE } satisfies EdgeDisplayLike;
        }
        const source = graph.source(edge);
        const target = graph.target(edge);
        const visible = kept.has(source) && kept.has(target);
        return {
          ...data,
          color: visible ? data.color : fadeToward(String(data.color), outlineColorRef.current, 0.7),
          size: visible ? EDGE_SIZE_HOVER : EDGE_SIZE,
        } satisfies EdgeDisplayLike;
      },
      hideEdgesOnMove: graph.order > HIDE_EDGES_ON_MOVE_AFTER,
    });
    sigmaRef.current = sigma;
    graphSigRef.current = graphSignature(graphData);

    sigma.resize();
    sigma.refresh();

    let paintRaf = 0;
    let mainRaf = 0;
    let watchdog = 0;
    let stopTimer = 0;
    let pulseHandler: (() => void) | null = null;

    const killSupervisor = (): void => {
      supervisorRef.current?.kill();
      supervisorRef.current = null;
    };

    const stopLoops = (): void => {
      if (paintRaf) {
        cancelAnimationFrame(paintRaf);
        paintRaf = 0;
      }
      if (mainRaf) {
        cancelAnimationFrame(mainRaf);
        mainRaf = 0;
      }
      if (watchdog) {
        window.clearTimeout(watchdog);
        watchdog = 0;
      }
      if (stopTimer) {
        window.clearTimeout(stopTimer);
        stopTimer = 0;
      }
      if (pulseHandler) {
        graph.removeListener("eachNodeAttributesUpdated", pulseHandler);
        pulseHandler = null;
      }
    };

    const pinNode = (node: string, attr: { x: number; y: number }): void => {
      const pin = pinnedRef.current.get(node);
      if (!pin) {
        return;
      }
      attr.x = pin.x;
      attr.y = pin.y;
    };

    const startPaint = (reseed: boolean): void => {
      if (paintRaf) {
        cancelAnimationFrame(paintRaf);
      }
      let frames = 0;
      const followUntil = reseed ? performance.now() + 1600 : 0;
      const tick = (): void => {
        if (!runningRef.current) {
          paintRaf = 0;
          return;
        }
        frames += 1;
        if (followUntil > 0 && performance.now() < followUntil && frames % 12 === 0) {
          fitToGraph(sigma, false);
        } else {
          sigma.refresh();
        }
        paintRaf = requestAnimationFrame(tick);
      };
      paintRaf = requestAnimationFrame(tick);
    };

    let iterations = 0;
    let lastPositions: Map<string, { x: number; y: number }> | null = null;
    let lastSampleAt = 0;
    let stableWindows = 0;

    const requestStop = (reason: LayoutHalt): void => {
      if (!runningRef.current) {
        return;
      }
      if (stopTimer) {
        return;
      }
      stopTimer = window.setTimeout(() => {
        stopTimer = 0;
        if (runningRef.current) {
          stopLayout(reason);
        }
      }, 0);
    };

    const noteIterations = (delta: number): void => {
      iterations += delta;
      if (iterations % 8 === 0 || iterations >= FA2_MAX_ITERATIONS) {
        setLayoutSteps(Math.min(iterations, FA2_MAX_ITERATIONS));
      }
      if (iterations >= FA2_MAX_ITERATIONS) {
        requestStop("cap");
        return;
      }
      if (iterations < FA2_WARMUP || iterations - lastSampleAt < FA2_SAMPLE_EVERY) {
        return;
      }
      lastSampleAt = iterations;
      const ratio = moveRatio(graph, lastPositions);
      lastPositions = snapshotPositions(graph);
      if (ratio < FA2_SETTLE_RATIO) {
        stableWindows += 1;
        if (stableWindows >= FA2_STABLE_WINDOWS) {
          requestStop("settled");
        }
      } else {
        stableWindows = 0;
      }
    };

    const startMainLoop = (): void => {
      if (mainRaf) {
        cancelAnimationFrame(mainRaf);
      }
      const step = (): void => {
        if (!runningRef.current) {
          mainRaf = 0;
          return;
        }
        const remaining = FA2_MAX_ITERATIONS - iterations;
        if (remaining <= 0) {
          mainRaf = 0;
          return;
        }
        const batch = Math.min(liveSteps(graph.order), remaining);
        try {
          forceAtlas2.assign(graph, {
            iterations: batch,
            settings: toFa2Settings(settingsRef.current),
          });
        } catch {
          // Keep painting even if a single FA2 tick fails.
        }
        pinnedRef.current.forEach((pin, node) => {
          if (!graph.hasNode(node)) {
            return;
          }
          graph.setNodeAttribute(node, "x", pin.x);
          graph.setNodeAttribute(node, "y", pin.y);
        });
        noteIterations(batch);
        if (runningRef.current) {
          mainRaf = requestAnimationFrame(step);
        } else {
          mainRaf = 0;
        }
      };
      mainRaf = requestAnimationFrame(step);
    };

    const startLayout = (reseed: boolean): void => {
      stopLoops();
      killSupervisor();
      if (stopTimer) {
        window.clearTimeout(stopTimer);
        stopTimer = 0;
      }
      if (reseed) {
        scatter(graph);
        sanitizePositions(graph);
        sigma.refresh();
        void fitToGraph(sigma, false);
      }
      iterations = 0;
      lastPositions = null;
      lastSampleAt = 0;
      stableWindows = 0;
      runningRef.current = true;
      setLayoutSteps(0);
      setLayoutHalt(null);
      setRunning(true);
      const settings = toFa2Settings(settingsRef.current);
      startPaint(reseed);
      try {
        const supervisor = new FA2LayoutSupervisor(graph, {
          settings,
          outputReducer: (node, attr) => {
            pinNode(String(node), attr);
            return attr;
          },
        }) as Fa2Supervisor;
        supervisorRef.current = supervisor;
        supervisor.start();
        let pulses = 0;
        pulseHandler = (): void => {
          pulses += 1;
          noteIterations(1);
        };
        graph.on("eachNodeAttributesUpdated", pulseHandler);
        watchdog = window.setTimeout(() => {
          watchdog = 0;
          if (!runningRef.current || supervisorRef.current !== supervisor) {
            return;
          }
          if (pulses === 0) {
            if (pulseHandler) {
              graph.removeListener("eachNodeAttributesUpdated", pulseHandler);
              pulseHandler = null;
            }
            supervisor.stop();
            supervisor.kill();
            if (supervisorRef.current === supervisor) {
              supervisorRef.current = null;
            }
            startMainLoop();
          }
        }, 320);
      } catch {
        startMainLoop();
      }
    };

    const stopLayout = (reason: LayoutHalt = "user"): void => {
      runningRef.current = false;
      stopLoops();
      if (stopTimer) {
        window.clearTimeout(stopTimer);
        stopTimer = 0;
      }
      const supervisor = supervisorRef.current;
      if (supervisor?.isRunning()) {
        supervisor.stop();
      }
      killSupervisor();
      sanitizePositions(graph);
      if (graph.order <= 2500 && settingsRef.current.adjustSizes) {
        preventOverlap(graph);
      }
      sigma.refresh();
      setLayoutSteps(Math.min(iterations, FA2_MAX_ITERATIONS));
      setLayoutHalt(reason);
      setRunning(false);
    };

    layoutApiRef.current = {
      start: startLayout,
      stop: stopLayout,
      apply: (controls, reseed) => {
        settingsRef.current = controls;
        const supervisor = supervisorRef.current as Fa2Supervisor | null;
        if (reseed) {
          startLayout(true);
          return;
        }
        if (!runningRef.current) {
          return;
        }
        if (supervisor) {
          supervisor.settings = toFa2Settings(controls);
        }
      },
    };

    const highlight = (nodeId: string): void => {
      const g = sigma.getGraph();
      hoveredRef.current = nodeId;
      keptRef.current = new Set([nodeId, ...g.neighbors(nodeId)]);
    };
    const clearHighlight = (): void => {
      hoveredRef.current = null;
      const keptId = selectedRef.current;
      const g = sigma.getGraph();
      if (keptId && g.hasNode(keptId)) {
        keptRef.current = new Set([keptId, ...g.neighbors(keptId)]);
      } else {
        keptRef.current = new Set();
      }
    };

    const endDrag = (): void => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      dragRef.current = null;
      pinnedRef.current.delete(drag.id);
      if (graph.hasNode(drag.id)) {
        graph.setNodeAttribute(drag.id, "fixed", false);
      }
      setDragging(false);
      sigma.setSetting("enableCameraPanning", true);
      sigma.refresh();
      if (drag.moved) {
        suppressClickRef.current = true;
      }
    };

    const onDownNode = (payload: { node: string; event: { x: number; y: number }; preventSigmaDefault: () => void }): void => {
      payload.preventSigmaDefault();
      const g = sigma.getGraph();
      if (!g.hasNode(payload.node)) {
        return;
      }
      pinnedRef.current.set(payload.node, {
        x: Number(g.getNodeAttribute(payload.node, "x")),
        y: Number(g.getNodeAttribute(payload.node, "y")),
      });
      g.setNodeAttribute(payload.node, "fixed", true);
      dragRef.current = {
        id: payload.node,
        moved: false,
        x: payload.event.x,
        y: payload.event.y,
      };
      setDragging(true);
      sigma.setSetting("enableCameraPanning", false);
    };
    const onMoveBody = (payload: { event: { x: number; y: number }; preventSigmaDefault: () => void }): void => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      payload.preventSigmaDefault();
      if (!drag.moved && Math.hypot(payload.event.x - drag.x, payload.event.y - drag.y) > DRAG_TOLERANCE_PX) {
        drag.moved = true;
      }
      const point = sigma.viewportToGraph({ x: payload.event.x, y: payload.event.y });
      const g = sigma.getGraph();
      if (!g.hasNode(drag.id)) {
        return;
      }
      g.setNodeAttribute(drag.id, "x", point.x);
      g.setNodeAttribute(drag.id, "y", point.y);
      pinnedRef.current.set(drag.id, { x: point.x, y: point.y });
      if (!runningRef.current) {
        sigma.refresh();
      }
    };
    const onEnterNode = ({ node, event }: { node: string; event: { x: number; y: number } }): void => {
      const g = sigma.getGraph();
      if (g.hasNode(node)) {
        setTip({
          x: event.x,
          y: event.y,
          title: String(g.getNodeAttribute(node, "title") ?? node),
          type: String(g.getNodeAttribute(node, "nodeType") ?? ""),
        });
      }
      highlight(node);
      sigma.refresh({ skipIndexation: true });
    };
    const onLeaveNode = (): void => {
      if (dragRef.current) {
        return;
      }
      clearHighlight();
      setTip(null);
      sigma.refresh({ skipIndexation: true });
    };
    const onClickNode = ({ node }: { node: string }): void => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      selectedRef.current = node;
      onSelectRef.current?.(node);
      highlight(node);
      sigma.refresh({ skipIndexation: true });
    };
    const onClickStage = (): void => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      selectedRef.current = null;
      onSelectRef.current?.(null);
      keptRef.current = new Set();
      sigma.refresh({ skipIndexation: true });
    };
    sigma.on("enterNode", onEnterNode);
    sigma.on("leaveNode", onLeaveNode);
    sigma.on("clickNode", onClickNode);
    sigma.on("clickStage", onClickStage);
    sigma.on("downNode", onDownNode);
    sigma.on("moveBody", onMoveBody);
    sigma.on("upNode", endDrag);
    sigma.on("upStage", endDrag);
    window.addEventListener("mouseup", endDrag);

    startLayout(true);

    const fitIfIdle = (): void => {
      sigma.resize();
      sigma.scheduleRefresh();
    };
    const observer = new ResizeObserver(fitIfIdle);
    observer.observe(container);

    return () => {
      runningRef.current = false;
      stopLoops();
      observer.disconnect();
      window.removeEventListener("mouseup", endDrag);
      layoutApiRef.current = null;
      killSupervisor();
      sigma.kill();
      sigmaRef.current = null;
      graphSigRef.current = "";
      keptRef.current = new Set();
      hoveredRef.current = null;
      selectedRef.current = null;
      dragRef.current = null;
      pinnedRef.current.clear();
    };
    // Recreate only when node presence flips; `graph` content changes are
    // pushed through the sync effect below, which preserves the instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasNodes]);

  // Data sync: rebuild the existing graphology graph without destroying the
  // sigma instance, so topology-identical graph objects do not re-run the
  // layout or reset the camera.
  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma) {
      return;
    }
    const signature = graphSignature(graphData);
    if (graphSigRef.current === signature) {
      return;
    }
    graphSigRef.current = signature;
    const graph = sigma.getGraph();
    graph.clear();
    fillGraph(graph, graphData, colorsRef.current, edgeColorRef.current, outlineColorRef.current);
    sigma.setSetting("hideEdgesOnMove", graph.order > HIDE_EDGES_ON_MOVE_AFTER);
    sigma.setSetting("defaultEdgeType", graph.order > ARROWS_UNTIL ? "line" : "arrow");
    layoutApiRef.current?.start(true);
  }, [graphData]);

  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma) {
      return;
    }
    sigma.setSetting("renderLabels", Boolean(showLabels));
  }, [showLabels]);

  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma) {
      return;
    }
    selectedRef.current = selectedId ?? null;
    const graph = sigma.getGraph();
    if (selectedId && graph.hasNode(selectedId)) {
      keptRef.current = new Set([selectedId, ...graph.neighbors(selectedId)]);
    } else {
      keptRef.current = new Set();
    }
    sigma.refresh({ skipIndexation: true });
  }, [selectedId, graphData]);

  useEffect(() => {
    if (!focusNonce) {
      return;
    }
    const sigma = sigmaRef.current;
    if (!sigma || !selectedId) {
      return;
    }
    const graph = sigma.getGraph();
    if (!graph.hasNode(selectedId)) {
      return;
    }
    fitToGraph(sigma, true, [selectedId, ...graph.neighbors(selectedId)]);
  }, [focusNonce, selectedId]);

  const skipFa2Apply = useRef(true);
  useEffect(() => {
    if (skipFa2Apply.current) {
      skipFa2Apply.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      layoutApiRef.current?.apply(fa2, false);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [fa2]);

  const toggleLayout = (): void => {
    if (running) {
      layoutApiRef.current?.stop();
      return;
    }
    layoutApiRef.current?.start(false);
  };

  const relayout = (): void => {
    layoutApiRef.current?.start(true);
  };

  if (graphData.nodes.length === 0) {
    return <p className={css.empty}>{emptyLabel}</p>;
  }

  return (
    <div ref={wrapRef} className={`${css.wrap} ${css.fill}`} data-dragging={dragging ? "true" : undefined}>
      <div className={css.stage}>
        <div ref={containerRef} className={css.cy} role="img" aria-label="OKF graph" />
        {tip ? (
          <div className={css.tip} style={{ left: tip.x, top: tip.y }} role="tooltip">
            <span className={css.tipType}>{tip.type}</span>
            {tip.title}
          </div>
        ) : null}
        <div className={css.zoom} role="group" aria-label="zoom">
          <button type="button" onClick={() => zoomBy(sigmaRef.current, 1.2)}>+</button>
          <button type="button" onClick={() => zoomBy(sigmaRef.current, 1 / 1.2)}>−</button>
          <button
            type="button"
            onClick={() => {
              if (sigmaRef.current) {
                fitToGraph(sigmaRef.current, true);
              }
            }}
          >
            {fitLabel ?? "Fit"}
          </button>
          <button type="button" data-active={running ? "true" : undefined} onClick={toggleLayout}>
            {running ? label("graph.layoutPause", "Pause") : label("graph.layoutPlay", "Run")}
          </button>
          <button type="button" onClick={relayout}>{relayoutLabel ?? "Relayout"}</button>
        </div>
        <aside className={css.layoutPanel} data-open={panelOpen ? "true" : undefined}>
          <button
            type="button"
            className={css.layoutToggle}
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen((open) => !open)}
          >
            {label("graph.layoutPanel", "ForceAtlas2")}
            <span className={css.layoutState}>
              {running
                ? `${label("graph.layoutRunning", "running")} · ${label("graph.layoutProgress", "{n} / {max}")
                    .replace("{n}", String(layoutSteps))
                    .replace("{max}", String(FA2_MAX_ITERATIONS))}`
                : `${layoutHalt === "settled"
                    ? label("graph.layoutSettled", "settled")
                    : layoutHalt === "cap"
                      ? label("graph.layoutCapped", "hit limit")
                      : label("graph.layoutStopped", "paused")} · ${label("graph.layoutSteps", "{n} steps").replace("{n}", String(layoutSteps))}`}
            </span>
          </button>
          {panelOpen ? (
            <div className={css.layoutBody}>
              <LayoutSlider
                label={label("graph.layoutGravity", "Gravity")}
                min={0.01}
                max={5}
                step={0.01}
                value={fa2.gravity}
                format={(value) => value.toFixed(2)}
                onChange={(gravity) => setFa2((current) => ({ ...current, gravity }))}
              />
              <LayoutSlider
                label={label("graph.layoutScaling", "Scaling")}
                min={1}
                max={80}
                step={0.5}
                value={fa2.scalingRatio}
                format={(value) => value.toFixed(1)}
                onChange={(scalingRatio) => setFa2((current) => ({ ...current, scalingRatio }))}
              />
              <LayoutSlider
                label={label("graph.layoutSlowDown", "Slow down")}
                min={0.4}
                max={15}
                step={0.1}
                value={fa2.slowDown}
                format={(value) => value.toFixed(1)}
                onChange={(slowDown) => setFa2((current) => ({ ...current, slowDown }))}
              />
              <label className={css.layoutCheck}>
                <input
                  type="checkbox"
                  checked={fa2.linLogMode}
                  onChange={(event) => setFa2((current) => ({ ...current, linLogMode: event.target.checked }))}
                />
                {label("graph.layoutLinLog", "LinLog")}
              </label>
              <label className={css.layoutCheck}>
                <input
                  type="checkbox"
                  checked={fa2.strongGravityMode}
                  onChange={(event) => setFa2((current) => ({ ...current, strongGravityMode: event.target.checked }))}
                />
                {label("graph.layoutStrongGravity", "Strong gravity")}
              </label>
              <label className={css.layoutCheck}>
                <input
                  type="checkbox"
                  checked={fa2.outboundAttractionDistribution}
                  onChange={(event) => setFa2((current) => ({ ...current, outboundAttractionDistribution: event.target.checked }))}
                />
                {label("graph.layoutHubs", "Dissuade hubs")}
              </label>
              <label className={css.layoutCheck}>
                <input
                  type="checkbox"
                  checked={fa2.adjustSizes}
                  onChange={(event) => setFa2((current) => ({ ...current, adjustSizes: event.target.checked }))}
                />
                {label("graph.layoutAdjust", "Prevent overlap")}
              </label>
              <label className={css.layoutCheck}>
                <input
                  type="checkbox"
                  checked={fa2.barnesHutOptimize}
                  onChange={(event) => setFa2((current) => ({ ...current, barnesHutOptimize: event.target.checked }))}
                />
                {label("graph.layoutBarnesHut", "Barnes-Hut")}
              </label>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function LayoutSlider({
  label: caption,
  min,
  max,
  step,
  value,
  format,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className={css.layoutSlider}>
      <span>
        {caption}
        <b>{format(value)}</b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function zoomBy(sigma: Sigma | null, factor: number): void {
  void sigma?.getCamera().animatedZoom({ factor }).then(() => {
    sigma?.refresh();
  });
}


function shortGraphLabel(title: string, type: string): string {
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
