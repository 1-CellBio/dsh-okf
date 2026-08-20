import { useEffect, useMemo, useRef, useState } from "react";
import type { OkfLocaleKey } from "./locales.ts";
import { PageReader } from "./PageReader.tsx";
import {
  REVIEW_KINDS,
  isReviewAction,
  type OrganizeSnapshot,
  type ReviewKind,
  type WorkbenchPage,
} from "./organize-model.ts";
import { fetchOkfJson } from "./session-fetch.ts";
import { useVirtualRows } from "./useVirtualRows.ts";
import css from "./GraphView.module.css";

type Lane = ReviewKind | "action" | "backlog" | "all";

const ROW_HEIGHT = 52;

type ReviewPaneProps = {
  snapshot: OrganizeSnapshot | null;
  sessionId: string;
  loading: boolean;
  t: (key: OkfLocaleKey) => string;
};

export function ReviewPane({ snapshot, sessionId, loading, t }: ReviewPaneProps) {
  const [lane, setLane] = useState<Lane>("action");
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState<WorkbenchPage | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  // Guard against stale responses: only the latest open() may update the page,
  // and nothing may touch state after unmount.
  const requestSeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const review = snapshot?.review;
  const items = review?.items ?? [];
  const present = REVIEW_KINDS.filter((item) => (review?.counts[item] ?? 0) > 0);
  const visible = useMemo(() => {
    if (lane === "all") {
      return items;
    }
    if (lane === "action") {
      return items.filter((item) => isReviewAction(item.kind));
    }
    if (lane === "backlog") {
      return items.filter((item) => !isReviewAction(item.kind));
    }
    return items.filter((item) => item.kind === lane);
  }, [items, lane]);

  // Windowing: review lanes can hold thousands of items after a bulk compile;
  // only the visible slice renders, spacer rows keep the scrollbar accurate.
  const listRef = useRef<HTMLDivElement>(null);
  const listMounted = visible.length > 0 || loading;
  const { start, end } = useVirtualRows(listRef, listMounted, visible.length, ROW_HEIGHT);
  const visibleItems = visible.slice(start, end);

  function open(path: string): void {
    setSelected(path);
    setPageLoading(true);
    setPageError(null);
    const seq = ++requestSeq.current;
    void fetchOkfJson<WorkbenchPage>("/okf/page", sessionId, { id: path })
      .then((next) => {
        if (seq === requestSeq.current && mounted.current) {
          setPage(next);
        }
      })
      .catch((cause: unknown) => {
        if (seq === requestSeq.current && mounted.current) {
          setPage(null);
          setPageError(cause instanceof Error ? cause.message : t("page.loadFailed"));
        }
      })
      .finally(() => {
        if (seq === requestSeq.current && mounted.current) {
          setPageLoading(false);
        }
      });
  }

  return (
    <section className={`${css.pane} ${css.split}`} aria-label={t("review.title")}>
      <p className={css.lead}>{t("review.hint")}</p>
      <div className={css.chips} role="tablist" aria-label={t("review.filters")}>
        <button
          type="button"
          className={css.chip}
          aria-selected={lane === "action"}
          onClick={() => setLane("action")}
        >
          {t("review.action")}
          <span>{review?.actionTotal ?? 0}</span>
        </button>
        <button
          type="button"
          className={css.chip}
          aria-selected={lane === "backlog"}
          onClick={() => setLane("backlog")}
        >
          {t("review.backlog")}
          <span>{review?.backlogTotal ?? 0}</span>
        </button>
        <button
          type="button"
          className={css.chip}
          aria-selected={lane === "all"}
          onClick={() => setLane("all")}
        >
          {t("review.all")}
          <span>{review?.total ?? 0}</span>
        </button>
        {present.map((item) => (
          <button
            key={item}
            type="button"
            className={css.chip}
            aria-selected={lane === item}
            onClick={() => setLane(item)}
          >
            {t(reviewKey(item))}
            <span>{review?.counts[item] ?? 0}</span>
          </button>
        ))}
      </div>
      {review?.truncated ? <p className={css.empty}>{t("review.truncated")}</p> : null}
      {visible.length === 0 && !loading ? (
        <p className={css.empty}>{lane === "action" ? t("review.actionEmpty") : t("review.empty")}</p>
      ) : (
        <div ref={listRef} className={css.splitList}>
          <table className={css.table}>
            <thead style={{ position: "sticky", top: 0, zIndex: 1 }}>
              <tr>
                <th className={css.colKind}>{t("review.colKind")}</th>
                <th>{t("review.colTitle")}</th>
                <th>{t("review.colPath")}</th>
                <th>{t("review.colDetail")}</th>
              </tr>
            </thead>
            <tbody>
              {start > 0 ? <tr aria-hidden="true" style={{ height: start * ROW_HEIGHT }} /> : null}
              {visibleItems.map((item) => (
                <tr
                  key={item.id}
                  className={css.clickRow}
                  data-selected={selected === item.path || undefined}
                  onClick={() => open(item.path)}
                >
                  <td><span className={css.status}>{t(reviewKey(item.kind))}</span></td>
                  <td>
                    <span className={css.paperTitle}>{item.title}</span>
                    {item.count && item.count > 1 ? (
                      <span className={css.muted}>{t("review.claimCount").replace("{n}", String(item.count))}</span>
                    ) : null}
                  </td>
                  <td className={css.pathCell}>
                    {item.path}
                    {item.otherPath ? <span className={css.muted}>{` → ${item.otherPath}`}</span> : null}
                  </td>
                  <td className={css.muted}>{item.detail}</td>
                </tr>
              ))}
              {end < visible.length ? <tr aria-hidden="true" style={{ height: (visible.length - end) * ROW_HEIGHT }} /> : null}
            </tbody>
          </table>
        </div>
      )}
      <PageReader
        page={page}
        loading={pageLoading}
        error={pageError}
        empty={t("review.openHint")}
        t={t}
      />
    </section>
  );
}

function reviewKey(kind: ReviewKind): OkfLocaleKey {
  if (kind === "missing_published") return "review.missing_published";
  if (kind === "missing_doi") return "review.missing_doi";
  if (kind === "low_confidence_biblio") return "review.low_confidence_biblio";
  if (kind === "disputed_claim") return "review.disputed_claim";
  if (kind === "extracted_claim") return "review.extracted_claim";
  if (kind === "near_duplicate") return "review.near_duplicate";
  if (kind === "merge_conflict") return "review.merge_conflict";
  return "review.draft";
}
