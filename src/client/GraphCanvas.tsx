import { useId, useMemo, useRef, useState } from "react";
import { layoutEdges, layoutForceGraph, type LaidOutNode } from "./graph-layout.ts";
import { GraphNetwork } from "./GraphNetwork.tsx";
import { graphSignature, type GraphData } from "./graph-model.ts";
import css from "./GraphCanvas.module.css";

export type GraphCanvasProps = {
  graph: GraphData;
  compact?: boolean;
  fill?: boolean;
  showLabels?: boolean;
  selectedId?: string | null;
  emptyLabel: string;
  fitLabel?: string;
  relayoutLabel?: string;
  focusNonce?: number;
  onSelect?: (id: string | null) => void;
};

type HoverTip = {
  x: number;
  y: number;
  title: string;
  type: string;
};

type Camera = { x: number; y: number; w: number; h: number };

export function GraphCanvas(props: GraphCanvasProps) {
  if (props.fill) {
    return (
      <GraphNetwork
        graph={props.graph}
        showLabels={props.showLabels}
        selectedId={props.selectedId}
        emptyLabel={props.emptyLabel}
        fitLabel={props.fitLabel}
        relayoutLabel={props.relayoutLabel}
        focusNonce={props.focusNonce}
        onSelect={props.onSelect}
      />
    );
  }
  return <SvgGraphCanvas {...props} />;
}

/** Compact chat-card graph. Fill mode uses Cytoscape cose like the workbench. */
function SvgGraphCanvas({
  graph,
  compact,
  fill,
  showLabels,
  selectedId = null,
  emptyLabel,
  fitLabel,
  relayoutLabel,
  onSelect,
}: GraphCanvasProps) {
  const [salt, setSalt] = useState(0);
  const sig = useMemo(() => graphSignature(graph), [graph]);
  const seed = useMemo(() => layoutForceGraph(graph, salt), [graph, salt]);
  const [nodes, setNodes] = useState<LaidOutNode[]>(seed.nodes);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, w: seed.width, h: seed.height });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const markerId = `okf-arrow-${useId().replace(/:/g, "")}`;
  const [tip, setTip] = useState<HoverTip | null>(null);

  // Reset positions/camera only when the topology or the relayout salt actually
  // changed. `seed` is recomputed whenever the `graph` object identity changes
  // (every chat turn), so a reference comparison would reset the camera even
  // when nothing about the graph changed.
  const [seedKey, setSeedKey] = useState({ sig, salt });
  if (seedKey.sig !== sig || seedKey.salt !== salt) {
    setSeedKey({ sig, salt });
    setNodes(seed.nodes);
    setCamera({ x: 0, y: 0, w: seed.width, h: seed.height });
  }

  const placed = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const edges = useMemo(() => layoutEdges(graph.edges, placed), [graph.edges, placed]);
  const focus = useMemo(() => neighborhood(selectedId, graph.edges), [selectedId, graph.edges]);

  if (seed.nodes.length === 0) {
    return <p className={css.empty}>{emptyLabel}</p>;
  }

  const wrapClass = [css.wrap, compact ? css.compact : "", fill ? css.fill : ""].filter(Boolean).join(" ");

  function zoomBy(factor: number): void {
    setCamera((current) => {
      const nextW = clamp(current.w / factor, seed.width / 2.8, seed.width / 0.45);
      const nextH = clamp(current.h / factor, seed.height / 2.8, seed.height / 0.45);
      return {
        x: current.x + (current.w - nextW) / 2,
        y: current.y + (current.h - nextH) / 2,
        w: nextW,
        h: nextH,
      };
    });
  }

  function fit(): void {
    setCamera({ x: 0, y: 0, w: seed.width, h: seed.height });
  }

  function relayout(): void {
    setSalt((value) => value + 1);
  }

  return (
    <div className={wrapClass}>
      <div className={css.stage}>
        <svg
          ref={svgRef}
          className={css.svg}
          viewBox={`${camera.x} ${camera.y} ${camera.w} ${camera.h}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="OKF graph"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              onSelect?.(null);
            }
          }}
        >
          <defs>
            <marker
              id={markerId}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0 0 L8 4 L0 8 Z" className={css.arrow} />
            </marker>
          </defs>
          {edges.map((edge) => (
            <line
              key={edge.id}
              className={css.edge}
              data-faded={focus && !edgeInFocus(edge.id, focus) ? "true" : undefined}
              x1={edge.x1}
              y1={edge.y1}
              x2={edge.x2}
              y2={edge.y2}
              markerEnd={`url(#${markerId})`}
            />
          ))}
          {nodes.map((node) => (
            <g
              key={node.id}
              className={css.node}
              data-type={node.type}
              data-selected={selectedId === node.id || undefined}
              data-faded={focus && !focus.has(node.id) ? "true" : undefined}
              transform={`translate(${node.x} ${node.y})`}
              onPointerDown={(event) => {
                event.stopPropagation();
                const svg = svgRef.current;
                if (!svg) {
                  return;
                }
                const point = clientToSvg(svg, event.clientX, event.clientY);
                dragRef.current = { id: node.id, dx: point.x - node.x, dy: point.y - node.y };
                event.currentTarget.setPointerCapture(event.pointerId);
                onSelect?.(node.id);
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                const svg = svgRef.current;
                if (!drag || drag.id !== node.id || !svg) {
                  return;
                }
                const point = clientToSvg(svg, event.clientX, event.clientY);
                const x = point.x - drag.dx;
                const y = point.y - drag.dy;
                setNodes((current) => current.map((item) => (
                  item.id === node.id ? { ...item, x, y } : item
                )));
              }}
              onPointerUp={() => {
                dragRef.current = null;
              }}
              onPointerCancel={() => {
                dragRef.current = null;
              }}
              onMouseEnter={(event) => {
                const wrap = event.currentTarget.closest(`.${css.stage}`)?.getBoundingClientRect();
                const ctm = event.currentTarget.getScreenCTM();
                if (!wrap || !ctm) {
                  return;
                }
                setTip({
                  x: ctm.e - wrap.left,
                  y: ctm.f - wrap.top,
                  title: node.title,
                  type: node.type,
                });
              }}
              onMouseLeave={() => setTip(null)}
            >
              <title>{`${node.type} · ${node.title}`}</title>
              <circle r={node.w / 2} role="button" tabIndex={0} aria-label={node.title} />
              {showLabels ? (
                <text className={css.label} x={0} y={node.w / 2 + 12} textAnchor="middle">
                  {node.label}
                </text>
              ) : null}
            </g>
          ))}
        </svg>
        {tip ? (
          <div className={css.tip} style={{ left: tip.x, top: tip.y }} role="tooltip">
            <span className={css.tipType}>{tip.type}</span>
            {tip.title}
          </div>
        ) : null}
        {fill ? (
          <div className={css.zoom} role="group" aria-label="zoom">
            <button type="button" onClick={() => zoomBy(1.2)}>+</button>
            <button type="button" onClick={() => zoomBy(1 / 1.2)}>−</button>
            <button type="button" onClick={fit}>{fitLabel ?? "Fit"}</button>
            <button type="button" onClick={relayout}>{relayoutLabel ?? "Relayout"}</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function clientToSvg(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const ctm = svg.getScreenCTM();
  if (!ctm) {
    return { x: clientX, y: clientY };
  }
  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;
  const mapped = point.matrixTransform(ctm.inverse());
  return { x: mapped.x, y: mapped.y };
}

function neighborhood(id: string | null, edges: GraphData["edges"]): Set<string> | null {
  if (!id) {
    return null;
  }
  const ids = new Set<string>([id]);
  for (const edge of edges) {
    if (edge.source === id) {
      ids.add(edge.target);
    }
    if (edge.target === id) {
      ids.add(edge.source);
    }
  }
  return ids;
}

function edgeInFocus(edgeId: string, focus: Set<string>): boolean {
  const split = edgeId.indexOf("->");
  if (split < 0) {
    return true;
  }
  return focus.has(edgeId.slice(0, split)) && focus.has(edgeId.slice(split + 2));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
