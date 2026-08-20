import type { CSSProperties } from "react";
import { OkfToolCard } from "./OkfToolCard.tsx";
import css from "./OkfToolCard.module.css";
import type { OkfLocaleKey } from "./locales.ts";
import { parseCoverageView, type CoverageView, type KgToolBlock } from "./parse.ts";

const TOPIC_CAP = 12;
const GAP_CAP = 8;

export type CoverageRowProps = {
  block: KgToolBlock;
  inspect?: () => void;
  t: (key: OkfLocaleKey) => string;
};

export function CoverageRow({ block, inspect, t }: CoverageRowProps) {
  const view = parseCoverageView(block);
  const topics = view.topics.slice(0, TOPIC_CAP);
  const gaps = view.gaps.slice(0, GAP_CAP);
  const max = Math.max(1, ...topics.flatMap((topic) => topic.counts));
  return (
    <OkfToolCard
      tool="okf_coverage"
      state={view.state}
      title={t("coverage.title")}
      summary={view.errorSummary ?? coverageSummary(view, t)}
      status={statusLabel(view.state, t)}
      inspectLabel={t("row.inspect")}
      inspect={inspect}
    >
      {view.topics.length === 0 && view.gaps.length === 0 ? (
        <p className={css.empty}>{t("coverage.empty")}</p>
      ) : (
        <>
          {view.years.length > 0 && topics.length > 0 ? (
            <div className={css.panel}>
              <div className={css.heatWrap}>
                <table className={css.heat}>
                  <thead>
                    <tr>
                      <th scope="col" />
                      {view.years.map((year) => (
                        <th key={year} scope="col">{year}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {topics.map((topic) => (
                      <tr key={topic.id}>
                        <th scope="row">{topic.title}</th>
                        {topic.counts.map((count, index) => {
                          const year = view.years[index] ?? String(index);
                          const empty = count === 0;
                          const level = empty ? 0 : Math.max(12, Math.round((count / max) * 100));
                          return (
                            <td key={`${topic.id}:${year}`}>
                              <div
                                className={css.cell}
                                data-empty={empty || undefined}
                                style={{ "--kg-level": String(level) } as CSSProperties}
                                title={`${topic.title} ${year}: ${count}`}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {view.topics.length > TOPIC_CAP ? (
                <p className={css.more}>{fill(t("coverage.moreTopics"), view.topics.length - TOPIC_CAP)}</p>
              ) : null}
            </div>
          ) : null}
          {gaps.length > 0 ? (
            <div className={css.panel}>
              <ul className={css.gapList}>
                {gaps.map((gap) => (
                  <li key={gap.id} className={css.gap}>
                    <span className={css.gapKind}>{gap.kind}</span>
                    <span className={css.gapTitle}>{gap.title}</span>
                    <span className={css.gapMeta}>{gap.year ?? gap.topicId ?? ""}</span>
                  </li>
                ))}
              </ul>
              {view.gaps.length > GAP_CAP ? (
                <p className={css.more}>{fill(t("coverage.moreGaps"), view.gaps.length - GAP_CAP)}</p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </OkfToolCard>
  );
}

function fill(template: string, n: number): string {
  return template.replaceAll("{n}", String(n));
}

function coverageSummary(view: CoverageView, t: CoverageRowProps["t"]): string {
  if (view.state === "running") {
    return view.topic ?? t("coverage.all");
  }
  const topic = view.topic ?? t("coverage.all");
  return `${topic} · ${fill(t("coverage.topics"), view.topics.length)} · ${fill(t("coverage.gaps"), view.gaps.length)}`;
}

function statusLabel(state: CoverageView["state"], t: CoverageRowProps["t"]): string | null {
  if (state === "running") return t("row.running");
  if (state === "error") return t("row.failed");
  if (state === "stopped") return t("row.stopped");
  return null;
}
