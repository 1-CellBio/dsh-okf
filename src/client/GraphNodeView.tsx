import { useEffect } from "react";
import { GraphCanvas } from "./GraphCanvas.tsx";
import type { GraphData } from "./graph-model.ts";
import type { OkfLocaleKey } from "./locales.ts";
import css from "./GraphNodeView.module.css";

export type GraphNodeViewProps = {
  node: { key: string; data: GraphData };
  sessionId: string;
  t: (key: OkfLocaleKey) => string;
  observeGraph: (sessionId: string, key: string, graph: GraphData) => void;
  forgetGraph: (sessionId: string, key: string) => void;
};

export function GraphNodeView(props: GraphNodeViewProps) {
  const { node, sessionId, observeGraph, forgetGraph } = props;
  useEffect(() => {
    observeGraph(sessionId, node.key, node.data);
    return () => {
      forgetGraph(sessionId, node.key);
    };
  }, [sessionId, node.key, node.data, observeGraph, forgetGraph]);
  return (
    <section className={css.card} aria-label={props.t("graph.title")}>
      <header className={css.head}>
        <span className={css.title}>{props.t("graph.title")}</span>
        <span className={css.count}>{props.t("graph.nodes").replace("{n}", String(node.data.nodes.length))}</span>
      </header>
      <GraphCanvas graph={node.data} compact emptyLabel={props.t("graph.empty")} />
    </section>
  );
}
