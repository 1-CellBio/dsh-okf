import { useEffect, useRef, useState } from "react";
import cytoscape, { type Core, type EventObject, type NodeSingular } from "cytoscape";
import { graphSignature, type GraphData } from "./graph-model.ts";
import { paintForCanvas, readPaint, resolvePluginGraphColors } from "./paint.ts";
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
};

type HoverTip = {
  x: number;
  y: number;
  title: string;
  type: string;
};

const COSE = {
  name: "cose" as const,
  animate: false,
  padding: 36,
  nodeRepulsion: () => 12000,
  idealEdgeLength: () => 92,
  nodeOverlap: 28,
  gravity: 0.25,
};

// cytoscape's cose layout is a synchronous main-thread force simulation
// (~O(iterations × V²)); at a few hundred nodes it freezes the UI for seconds
// when the user sets maxNodes=0 (no cap). Above this limit fall back to the
// concentric layout, which is O(V log V) and keeps hubs (high degree) central.
const COSE_NODE_LIMIT = 300;

const CONCENTRIC = {
  name: "concentric" as const,
  animate: false,
  padding: 36,
  concentric: (node: NodeSingular) => node.degree(false),
  levelWidth: () => 2,
  minNodeSpacing: 12,
};

function layoutFor(nodeCount: number): cytoscape.LayoutOptions {
  return nodeCount <= COSE_NODE_LIMIT ? (COSE as cytoscape.LayoutOptions) : (CONCENTRIC as cytoscape.LayoutOptions);
}

/** Same cytoscape cose network as the workbench graph page. */
export function GraphNetwork(props: GraphNetworkProps) {
  const { graph, showLabels, selectedId = null, emptyLabel, fitLabel, relayoutLabel, focusNonce, onSelect } = props;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const graphSigRef = useRef("");
  const onSelectRef = useRef(onSelect);
  const selectedIdRef = useRef(selectedId);
  const [tip, setTip] = useState<HoverTip | null>(null);

  useEffect(() => {
    onSelectRef.current = onSelect;
    selectedIdRef.current = selectedId;
  });

  const hasNodes = graph.nodes.length > 0;

  // Instance lifecycle: create once when the container appears, destroy only on
  // unmount or when the graph becomes empty. The instance is deliberately NOT
  // tied to the `graph` identity, so topology-identical updates keep the same
  // cytoscape instance, its layout, and its camera (a prior version tried to
  // preserve via an early-return inside a [graph] effect, but React runs the
  // cleanup — which destroyed the instance — before the effect re-ran, making
  // that early-return dead code).
  useEffect(() => {
    const container = containerRef.current;
    const wrap = wrapRef.current;
    if (!container || !wrap || !hasNodes) {
      return;
    }
    const colors = resolvePluginGraphColors(wrap);
    const label = readPaint(wrap, "--dsw-alias-label-primary", "oklch(0.145 0 0)");
    const outline = readPaint(wrap, "--dsw-alias-bg-layer-1", "oklch(1 0 0)");
    const edge = readPaint(wrap, "--dsw-alias-label-tertiary", "oklch(0.556 0 0)");
    const nodes = graph.nodes.map((node) => ({
      data: {
        id: node.id,
        label: node.title,
        shortLabel: shortGraphLabel(node.title, node.type),
        type: node.type,
      },
    }));
    const edges = graph.edges.map((item) => ({
      data: {
        id: `${item.source}->${item.target}`,
        source: item.source,
        target: item.target,
      },
    }));
    const cy = cytoscape({
      container,
      elements: [...nodes, ...edges],
      minZoom: 0.35,
      maxZoom: 2.8,
      wheelSensitivity: 0.25,
      selectionType: "single",
      layout: layoutFor(graph.nodes.length),
      style: [
        {
          selector: "node",
          style: {
            label: "",
            "font-size": 11,
            "font-family": "ui-sans-serif, system-ui, sans-serif",
            color: label,
            "background-color": paintForCanvas("oklch(0.708 0 0)"),
            width: 18,
            height: 18,
            "text-valign": "bottom",
            "text-halign": "center",
            "text-margin-y": 6,
            "text-max-width": "88px",
            "text-wrap": "ellipsis",
            "text-outline-color": outline,
            "text-outline-width": 2,
            "overlay-opacity": 0,
          },
        },
        ...Object.entries(colors).map(([type, color]) => ({
          selector: `node[type = "${type}"]`,
          style: { "background-color": color },
        })),
        {
          selector: "node.show-label",
          style: { label: "data(shortLabel)" },
        },
        {
          selector: "node:selected",
          style: {
            width: 24,
            height: 24,
            "border-width": 2,
            "border-color": label,
            "border-opacity": 1,
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.1,
            "line-color": edge,
            "target-arrow-color": edge,
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.65,
            "curve-style": "bezier",
            opacity: 0.8,
          },
        },
        {
          selector: ".faded",
          style: { opacity: 0.14 },
        },
      ],
    });
    cyRef.current = cy;
    graphSigRef.current = graphSignature(graph);

    const highlight = (node: NodeSingular): void => {
      cy.elements().addClass("faded");
      node.neighborhood().union(node).removeClass("faded");
    };
    const clear = (): void => {
      cy.elements().removeClass("faded");
    };
    let userMoved = false;
    let fitting = false;
    const fitIfIdle = (): void => {
      cy.resize();
      if (!userMoved && container.clientWidth > 8 && container.clientHeight > 8) {
        fitting = true;
        cy.fit(undefined, 40);
        fitting = false;
      }
    };
    cy.on("zoom pan", () => {
      if (!fitting) {
        userMoved = true;
      }
    });
    requestAnimationFrame(fitIfIdle);
    const observer = new ResizeObserver(fitIfIdle);
    observer.observe(container);

    cy.on("mouseover", "node", (event: EventObject) => {
      const node = event.target as NodeSingular;
      const pos = node.renderedPosition();
      setTip({
        x: pos.x,
        y: pos.y,
        title: String(node.data("label") ?? ""),
        type: String(node.data("type") ?? ""),
      });
      highlight(node);
    });
    cy.on("mouseout", "node", () => {
      setTip(null);
      const keptId = selectedIdRef.current;
      const kept = keptId ? cy.getElementById(keptId) : null;
      if (kept && kept.nonempty() && kept.isNode()) {
        highlight(kept as NodeSingular);
        return;
      }
      clear();
    });
    cy.on("tap", "node", (event: EventObject) => {
      const node = event.target as NodeSingular;
      onSelectRef.current?.(node.id());
      highlight(node);
    });
    cy.on("tap", (event: EventObject) => {
      if (event.target === cy) {
        onSelectRef.current?.(null);
        clear();
      }
    });

    return () => {
      observer.disconnect();
      cy.destroy();
      cyRef.current = null;
      graphSigRef.current = "";
    };
    // Recreate only when node presence flips; `graph` content changes are pushed
    // through the sync effect below, which preserves the instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasNodes]);

  // Data sync: update the existing instance's elements without destroying it, so
  // topology-identical graph objects do not re-run the synchronous cose layout
  // or reset the camera.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    const signature = graphSignature(graph);
    if (graphSigRef.current === signature) {
      return;
    }
    graphSigRef.current = signature;
    cy.elements().remove();
    cy.add([
      ...graph.nodes.map((node) => ({
        data: {
          id: node.id,
          label: node.title,
          shortLabel: shortGraphLabel(node.title, node.type),
          type: node.type,
        },
      })),
      ...graph.edges.map((item) => ({
        data: {
          id: `${item.source}->${item.target}`,
          source: item.source,
          target: item.target,
        },
      })),
    ]);
    cy.layout(layoutFor(graph.nodes.length)).run();
  }, [graph]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    if (showLabels) {
      cy.nodes().addClass("show-label");
    } else {
      cy.nodes().removeClass("show-label");
    }
  }, [showLabels, graph]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) {
      return;
    }
    cy.nodes().unselect();
    cy.elements().removeClass("faded");
    if (!selectedId) {
      return;
    }
    const node = cy.getElementById(selectedId);
    if (node.nonempty() && node.isNode()) {
      node.select();
      cy.elements().addClass("faded");
      node.neighborhood().union(node).removeClass("faded");
    }
  }, [selectedId, graph]);

  useEffect(() => {
    if (!focusNonce) {
      return;
    }
    const cy = cyRef.current;
    if (!cy || !selectedId) {
      return;
    }
    const node = cy.getElementById(selectedId);
    if (node.empty() || !node.isNode()) {
      return;
    }
    cy.animate(
      { fit: { eles: node.neighborhood().union(node), padding: 48 } },
      { duration: 220 },
    );
  }, [focusNonce, selectedId]);

  if (graph.nodes.length === 0) {
    return <p className={css.empty}>{emptyLabel}</p>;
  }

  return (
    <div ref={wrapRef} className={`${css.wrap} ${css.fill}`}>
      <div className={css.stage}>
        <div ref={containerRef} className={css.cy} role="img" aria-label="OKF graph" />
        {tip ? (
          <div className={css.tip} style={{ left: tip.x, top: tip.y }} role="tooltip">
            <span className={css.tipType}>{tip.type}</span>
            {tip.title}
          </div>
        ) : null}
        <div className={css.zoom} role="group" aria-label="zoom">
          <button type="button" onClick={() => zoomBy(cyRef.current, 1.2)}>+</button>
          <button type="button" onClick={() => zoomBy(cyRef.current, 1 / 1.2)}>−</button>
          <button type="button" onClick={() => cyRef.current?.fit(undefined, 40)}>
            {fitLabel ?? "Fit"}
          </button>
          <button
            type="button"
            onClick={() => {
              const cy = cyRef.current;
              if (!cy) {
                return;
              }
              const base = layoutFor(cy.nodes().length);
              cy.one("layoutstop", () => cy.fit(undefined, 40));
              cy.layout({ ...base, animate: true, animationDuration: 420, randomize: true } as cytoscape.LayoutOptions).run();
            }}
          >
            {relayoutLabel ?? "Relayout"}
          </button>
        </div>
      </div>
    </div>
  );
}

function zoomBy(cy: Core | null, factor: number): void {
  if (!cy) {
    return;
  }
  cy.zoom({
    level: cy.zoom() * factor,
    renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
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
