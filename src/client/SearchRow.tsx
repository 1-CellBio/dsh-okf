import { OkfToolCard } from "./OkfToolCard.tsx";
import css from "./OkfToolCard.module.css";
import type { OkfLocaleKey } from "./locales.ts";
import { parseSearchView, type KgToolBlock, type ToolLifecycle } from "./parse.ts";

const HIT_CAP = 16;

export type SearchRowProps = {
  block: KgToolBlock;
  inspect?: () => void;
  t: (key: OkfLocaleKey) => string;
};

export function SearchRow({ block, inspect, t }: SearchRowProps) {
  const view = parseSearchView(block);
  const summary = view.errorSummary
    ?? (view.state === "running"
      ? view.query
      : view.hits.length === 0
        ? t("search.empty")
        : `${view.query}${view.type ? ` · ${view.type}` : ""} · ${fill(t("search.hits"), view.hits.length)}`);
  const hits = view.hits.slice(0, HIT_CAP);
  return (
    <OkfToolCard
      tool="okf_search"
      state={view.state}
      title={t("search.title")}
      summary={summary || t("search.title")}
      status={statusLabel(view.state, t)}
      inspectLabel={t("row.inspect")}
      inspect={inspect}
    >
      {view.hits.length === 0 ? (
        <p className={css.empty}>{t("search.empty")}</p>
      ) : (
        <div className={css.panel}>
          <ul className={css.hitList}>
            {hits.map((hit) => (
              <li key={hit.id} className={css.hit}>
                <span className={css.hitType}>{hit.type}</span>
                <span className={css.hitTitle}>{hit.title}</span>
                <span className={css.hitMeta}>{hit.published ?? hit.id}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </OkfToolCard>
  );
}

function fill(template: string, n: number): string {
  return template.replaceAll("{n}", String(n));
}

function statusLabel(state: ToolLifecycle, t: SearchRowProps["t"]): string | null {
  if (state === "running") return t("row.running");
  if (state === "error") return t("row.failed");
  if (state === "stopped") return t("row.stopped");
  return null;
}
