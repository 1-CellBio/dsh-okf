import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { OkfLocaleKey } from "./locales.ts";
import { MarkdownView } from "./MarkdownView.tsx";
import { stripLeadingTitle } from "./markdown.ts";
import {
  REVIEW_KINDS,
  isReviewAction,
  type OrganizeSnapshot,
  type ReviewItem,
  type ReviewKind,
  type WorkbenchPage,
} from "./organize-model.ts";
import { fetchOkfJson, postOkfJson } from "./session-fetch.ts";
import { useVirtualRows } from "./useVirtualRows.ts";
import css from "./GraphView.module.css";

type Lane = ReviewKind | "action" | "backlog" | "all";
type SuggestKeep = "left" | "right" | "both";
type ReviewSuggest = { keep: SuggestKeep; reason: string; source: "ai" | "heuristic" };

const ROW_HEIGHT = 64;
const SUGGEST_TIMEOUT_MS = 45_000;

type ReviewPaneProps = {
  snapshot: OrganizeSnapshot | null;
  sessionId: string;
  loading: boolean;
  t: (key: OkfLocaleKey) => string;
  onMutated?: () => void;
};

export function ReviewPane({ snapshot, sessionId, loading, t, onMutated }: ReviewPaneProps) {
  const [lane, setLane] = useState<Lane>("action");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [leftPage, setLeftPage] = useState<WorkbenchPage | null>(null);
  const [rightPage, setRightPage] = useState<WorkbenchPage | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<ReviewSuggest | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const requestSeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const review = snapshot?.review;
  const items = useMemo(
    () => (review?.items ?? []).filter((item) => !hiddenIds.has(item.id)),
    [review?.items, hiddenIds],
  );
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

  const selected = visible.find((item) => item.id === selectedId) ?? items.find((item) => item.id === selectedId) ?? null;

  const listRef = useRef<HTMLDivElement>(null);
  const listMounted = visible.length > 0 || loading;
  const { start, end } = useVirtualRows(listRef, listMounted, visible.length, ROW_HEIGHT);
  const visibleItems = visible.slice(start, end);

  function close(): void {
    requestSeq.current += 1;
    setSelectedId(null);
    setLeftPage(null);
    setRightPage(null);
    setPageError(null);
    setPageLoading(false);
    setSuggest(null);
    setSuggestLoading(false);
  }

  function open(item: ReviewItem): void {
    if (selectedId === item.id) {
      close();
      return;
    }
    setSelectedId(item.id);
    setPageLoading(true);
    setPageError(null);
    setActionError(null);
    setLeftPage(null);
    setRightPage(null);
    setSuggest(null);
    setSuggestLoading(Boolean(item.kind === "near_duplicate" && item.otherPath));
    const seq = ++requestSeq.current;
    const leftReq = fetchOkfJson<WorkbenchPage>("/okf/page", sessionId, { id: item.path });
    const rightReq = item.otherPath
      ? fetchOkfJson<WorkbenchPage>("/okf/page", sessionId, { id: item.otherPath })
      : Promise.resolve(null);
    const suggestReq =
      item.kind === "near_duplicate" && item.otherPath
        ? fetchOkfJson<ReviewSuggest>(
            "/okf/review-suggest",
            sessionId,
            { left: item.path, right: item.otherPath, reason: shortReason(item.detail) },
            SUGGEST_TIMEOUT_MS,
          )
        : Promise.resolve(null);
    void Promise.allSettled([leftReq, rightReq]).then(([left, right]) => {
      if (seq !== requestSeq.current || !mounted.current) {
        return;
      }
      if (left.status === "fulfilled") {
        setLeftPage(left.value);
      } else {
        setPageError(left.reason instanceof Error ? left.reason.message : t("page.loadFailed"));
      }
      if (right.status === "fulfilled") {
        setRightPage(right.value);
      }
      setPageLoading(false);
    });
    void suggestReq.then(
      (value) => {
        if (seq !== requestSeq.current || !mounted.current) {
          return;
        }
        setSuggest(value);
        setSuggestLoading(false);
      },
      () => {
        if (seq !== requestSeq.current || !mounted.current) {
          return;
        }
        setSuggestLoading(false);
      },
    );
  }

  useEffect(() => {
    if (!selectedId) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  function runAction(item: ReviewItem, action: "merge" | "dismiss", from: string, to: string): void {
    setHiddenIds((current) => {
      const next = new Set(current);
      next.add(item.id);
      return next;
    });
    close();
    setActionError(null);
    void postOkfJson("/okf/review", sessionId, { action, from, to })
      .then(() => {
        onMutated?.();
      })
      .catch((cause: unknown) => {
        if (!mounted.current) {
          return;
        }
        setHiddenIds((current) => {
          const next = new Set(current);
          next.delete(item.id);
          return next;
        });
        setActionError(cause instanceof Error ? cause.message : t("review.actionFailed"));
      });
  }

  const shownAction = items.filter((item) => isReviewAction(item.kind)).length;
  const shownTotal = items.length;
  const kindCounts = useMemo(() => {
    const counts = Object.fromEntries(REVIEW_KINDS.map((kind) => [kind, 0])) as Record<ReviewKind, number>;
    for (const item of items) {
      counts[item.kind] += 1;
    }
    return counts;
  }, [items]);
  const present = REVIEW_KINDS.filter((kind) => kindCounts[kind] > 0);

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
          <span>{shownAction}</span>
        </button>
        {(review?.backlogTotal ?? 0) > 0 ? (
          <button
            type="button"
            className={css.chip}
            aria-selected={lane === "backlog"}
            onClick={() => setLane("backlog")}
          >
            {t("review.backlog")}
            <span>{review?.backlogTotal ?? 0}</span>
          </button>
        ) : null}
        <button
          type="button"
          className={css.chip}
          aria-selected={lane === "all"}
          onClick={() => setLane("all")}
        >
          {t("review.all")}
          <span>{shownTotal}</span>
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
            <span>{kindCounts[item] ?? 0}</span>
          </button>
        ))}
      </div>
      {actionError ? <p className={css.error} role="alert">{actionError}</p> : null}
      {review?.truncated ? <p className={css.empty}>{t("review.truncated")}</p> : null}
      {visible.length === 0 && !loading ? (
        <p className={css.empty}>{lane === "action" ? t("review.actionEmpty") : t("review.empty")}</p>
      ) : selected ? (
        <div className={css.reviewFocus}>
          <div className={css.reviewItemBar}>
            <button type="button" className={css.reviewBack} onClick={close}>
              {t("review.backToList")}
            </button>
            <span className={css.status}>{t(reviewKey(selected.kind))}</span>
            <div className={css.reviewItemMain}>
              <span className={css.paperTitle}>{selected.title}</span>
              {selected.otherTitle ? <span className={css.pairOther}>{`≈ ${selected.otherTitle}`}</span> : null}
              <span className={css.pathCell}>{formatPaths(selected)}</span>
            </div>
            <span className={css.reasonCell} title={selected.detail}>{reasonLabel(selected.detail, t)}</span>
            <button type="button" className={css.readerClose} onClick={close} aria-label={t("review.close")}>
              ×
            </button>
          </div>
          <article className={`${css.reader} ${css.reviewPanel}`} aria-label={t("review.title")}>
            {selected.kind === "near_duplicate" && selected.otherPath ? (
              <>
                <p className={css.reviewSection}>{t("review.previewLabel")}</p>
                {suggestLoading ? <p className={css.suggestHint}>{t("review.suggestLoading")}</p> : null}
                {suggest ? (
                  <p className={css.suggestHint}>
                    <span className={css.suggestBadge}>
                      {suggest.source === "ai" ? t("review.suggestBadge") : t("review.suggestRule")}
                    </span>
                    {suggest.reason}
                  </p>
                ) : null}
                {pageError ? <p className={css.error} role="alert">{pageError}</p> : null}
                {pageLoading && !leftPage && !rightPage ? (
                  <p className={css.empty}>{t("library.loading")}</p>
                ) : (
                  <div className={css.compare}>
                    <ConceptColumn
                      label={t("review.pickThis")}
                      page={leftPage}
                      empty={t("review.previewEmpty")}
                      t={t}
                      suggested={suggest?.keep === "left"}
                      onPick={() => runAction(selected, "merge", selected.otherPath!, selected.path)}
                    />
                    <ConceptColumn
                      label={t("review.pickThis")}
                      page={rightPage}
                      empty={t("review.previewEmpty")}
                      t={t}
                      suggested={suggest?.keep === "right"}
                      onPick={() => runAction(selected, "merge", selected.path, selected.otherPath!)}
                    />
                  </div>
                )}
                <div className={css.keepBothRow}>
                  <button
                    type="button"
                    className={css.reviewActionGhost}
                    data-suggest={suggest?.keep === "both" ? "true" : undefined}
                    onClick={() => runAction(selected, "dismiss", selected.path, selected.otherPath!)}
                  >
                    {t("review.keepBoth")}
                    {suggest?.keep === "both" ? (
                      <span className={css.suggestBadge}>{t("review.suggestBadge")}</span>
                    ) : null}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className={css.reviewActionHint}>{howto(selected, t)}</p>
                {pageError ? <p className={css.error} role="alert">{pageError}</p> : null}
                {pageLoading && !leftPage ? (
                  <p className={css.empty}>{t("library.loading")}</p>
                ) : (
                  <div className={css.compareSolo}>
                    <ConceptColumn
                      label={t("review.previewSolo")}
                      page={leftPage}
                      empty={t("review.previewEmpty")}
                      t={t}
                    />
                  </div>
                )}
              </>
            )}
          </article>
        </div>
      ) : (
        <div ref={listRef} className={css.splitList}>
          <table className={`${css.table} ${css.reviewTable}`}>
            <thead>
              <tr>
                <th className={css.colKind} title={t("review.colKindHint")}>{t("review.colKind")}</th>
                <th title={t("review.colPairHint")}>{t("review.colPair")}</th>
                <th className={css.colReason} title={t("review.colReasonHint")}>{t("review.colDetail")}</th>
              </tr>
            </thead>
            <tbody>
              {start > 0 ? <tr aria-hidden="true" style={{ height: start * ROW_HEIGHT }} /> : null}
              {visibleItems.map((item) => (
                <tr
                  key={item.id}
                  className={css.clickRow}
                  onClick={() => open(item)}
                >
                  <td><span className={css.status}>{t(reviewKey(item.kind))}</span></td>
                  <td>
                    <span className={css.paperTitle}>{item.title}</span>
                    {item.otherTitle ? <span className={css.pairOther}>{`≈ ${item.otherTitle}`}</span> : null}
                    {item.count && item.count > 1 ? (
                      <span className={css.muted}>{t("review.claimCount").replace("{n}", String(item.count))}</span>
                    ) : null}
                    <span className={css.pathCell}>{formatPaths(item)}</span>
                  </td>
                  <td className={css.reasonCell} title={item.detail}>{reasonLabel(item.detail, t)}</td>
                </tr>
              ))}
              {end < visible.length ? <tr aria-hidden="true" style={{ height: (visible.length - end) * ROW_HEIGHT }} /> : null}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ConceptColumn({
  label,
  page,
  empty,
  t,
  suggested,
  onPick,
}: {
  label: string;
  page: WorkbenchPage | null;
  empty: string;
  t: (key: OkfLocaleKey) => string;
  suggested?: boolean;
  onPick?: () => void;
}): ReactNode {
  const source = page ? stripLeadingTitle(page.body, page.title) : "";
  function pick(event: { target: EventTarget | null }): void {
    if (!onPick) {
      return;
    }
    if (event.target instanceof Element && event.target.closest("a")) {
      return;
    }
    onPick();
  }
  return (
    <div
      className={css.compareCol}
      data-pick={onPick ? "true" : undefined}
      data-suggest={suggested ? "true" : undefined}
      role={onPick ? "button" : undefined}
      tabIndex={onPick ? 0 : undefined}
      onClick={onPick ? (event) => pick(event) : undefined}
      onKeyDown={
        onPick
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onPick();
              }
            }
          : undefined
      }
    >
      <p className={css.reviewSection}>
        {label}
        {suggested ? <span className={css.suggestBadge}>{t("review.suggestThis")}</span> : null}
      </p>
      {page ? (
        <>
          <h4 className={css.compareTitle}>{page.title || page.id}</h4>
          <p className={css.readerMeta}>
            <span className={css.muted}>{page.path}</span>
            {page.status ? <span className={css.status}>{page.status}</span> : null}
          </p>
          {source ? <MarkdownView source={source} /> : <p className={css.empty}>{t("page.emptyBody")}</p>}
        </>
      ) : (
        <p className={css.empty}>{empty}</p>
      )}
    </div>
  );
}

function formatPaths(item: ReviewItem): string {
  const left = shortPath(item.path);
  if (!item.otherPath) {
    return left;
  }
  return `${left} → ${shortPath(item.otherPath)}`;
}

function shortPath(path: string): string {
  const trimmed = path.replace(/^\/+/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function shortReason(detail: string): string {
  const paren = detail.match(/\(([^)]+)\)\s*$/);
  return paren?.[1] ?? detail;
}

function reasonLabel(detail: string, t: (key: OkfLocaleKey) => string): string {
  const code = shortReason(detail);
  if (code.startsWith("token:contain")) {
    return t("review.reasonContain");
  }
  if (code.startsWith("token:equal")) {
    return t("review.reasonEqual");
  }
  if (code.startsWith("edit-distance:")) {
    return t("review.reasonEdit");
  }
  if (code.startsWith("align:")) {
    return t("review.reasonAlign");
  }
  return code;
}

function howto(item: ReviewItem | null, t: (key: OkfLocaleKey) => string): string {
  if (!item) {
    return t("review.openHint");
  }
  if (item.kind === "near_duplicate") {
    return t("review.nearHint");
  }
  if (item.kind === "missing_published") {
    return t("review.missingPublishedHint");
  }
  if (item.kind === "missing_doi") {
    return t("review.missingDoiHint");
  }
  if (item.kind === "low_confidence_biblio") {
    return t("review.biblioHint");
  }
  if (item.kind === "merge_conflict") {
    return t("review.mergeHint");
  }
  return t("review.openHint");
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
