import type { CSSProperties } from "react";
import type { OkfLocaleKey } from "./locales.ts";
import type { CoverageSnapshot } from "./organize-model.ts";
import css from "./GraphView.module.css";

type CoveragePaneProps = {
  snapshot: CoverageSnapshot | null;
  loading: boolean;
  t: (key: OkfLocaleKey) => string;
};

const GAP_SHOWN = 40;

export function CoveragePane({ snapshot, loading, t }: CoveragePaneProps) {
  const topics = snapshot?.topics ?? [];
  const years = snapshot?.years ?? [];
  const gaps = snapshot?.gaps ?? [];
  const max = Math.max(1, ...topics.flatMap((topic) => topic.counts));

  if (!snapshot && !loading) {
    return <p className={css.empty}>{t("coverage.empty")}</p>;
  }

  return (
    <section className={css.pane} aria-label={t("coverage.title")}>
      <p className={css.lead}>{t("coverage.pageHint")}</p>
      {years.length > 0 && topics.length > 0 ? (
        <div className={css.heatWrap}>
          <table className={css.heat}>
            <thead>
              <tr>
                <th scope="col" />
                {years.map((year) => (
                  <th key={year} scope="col">{year}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {topics.map((topic) => (
                <tr key={topic.id}>
                  <th scope="row">{topic.title}</th>
                  {topic.counts.map((count, index) => {
                    const year = years[index] ?? String(index);
                    const empty = count === 0;
                    const level = empty ? 0 : Math.max(12, Math.round((count / max) * 100));
                    return (
                      <td key={`${topic.id}:${year}`}>
                        <div
                          className={css.heatCell}
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
      ) : loading ? (
        <p className={css.empty}>{t("library.loading")}</p>
      ) : (
        <p className={css.empty}>{t("coverage.empty")}</p>
      )}
      {gaps.length > 0 ? (
        <details className={css.gapDetails}>
          <summary>{t("coverage.gapList")} · {gaps.length}</summary>
          <ul className={css.gapList}>
            {gaps.slice(0, GAP_SHOWN).map((gap) => (
              <li key={gap.id} className={css.gap}>
                <span className={css.status}>{gap.kind}</span>
                <span>{gap.title}</span>
              </li>
            ))}
          </ul>
          {gaps.length > GAP_SHOWN ? (
            <p className={css.more}>{fill(t("coverage.moreGaps"), gaps.length - GAP_SHOWN)}</p>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}

function fill(template: string, n: number): string {
  return template.replaceAll("{n}", String(n));
}
