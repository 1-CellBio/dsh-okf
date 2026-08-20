import { useEffect, useMemo, useRef, useState } from "react";
import type { OkfLocaleKey } from "./locales.ts";
import { PageReader } from "./PageReader.tsx";
import type { OrganizeCard, OrganizeSnapshot, WorkbenchPage } from "./organize-model.ts";
import { fetchOkfJson } from "./session-fetch.ts";
import { useVirtualRows } from "./useVirtualRows.ts";
import css from "./GraphView.module.css";

type DocsMode = "notes" | "questions" | "surveys";

const ROW_HEIGHT = 52;

type DocsPaneProps = {
  snapshot: OrganizeSnapshot | null;
  sessionId: string;
  loading: boolean;
  mode: "notes" | "surveys";
  t: (key: OkfLocaleKey) => string;
};

export function DocsPane({ snapshot, sessionId, loading, mode, t }: DocsPaneProps) {
  const [sub, setSub] = useState<DocsMode>(mode === "surveys" ? "surveys" : "notes");
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

  const cards: OrganizeCard[] = sub === "notes"
    ? snapshot?.notes ?? []
    : sub === "questions"
      ? snapshot?.questions ?? []
      : snapshot?.surveys ?? [];
  const manuscripts = mode === "surveys" ? snapshot?.manuscripts ?? [] : [];

  const rows = useMemo(
    () => [
      ...cards.map((card) => ({ id: card.id, title: card.title, meta: card.status, excerpt: card.excerpt, path: card.path })),
      ...manuscripts.map((path) => ({
        id: path,
        title: path.replace(/^manuscripts\//, ""),
        meta: t("survey.manuscript"),
        excerpt: "",
        path,
      })),
    ],
    [cards, manuscripts, t],
  );

  // Windowing: only the visible slice of the (potentially thousands of) note /
  // question / survey rows renders; spacer rows keep the scrollbar accurate.
  const listRef = useRef<HTMLDivElement>(null);
  const listMounted = rows.length > 0 || loading;
  const { start, end } = useVirtualRows(listRef, listMounted, rows.length, ROW_HEIGHT);
  const visibleRows = rows.slice(start, end);

  function open(id: string): void {
    setSelected(id);
    setPageLoading(true);
    setPageError(null);
    const seq = ++requestSeq.current;
    void fetchOkfJson<WorkbenchPage>("/okf/page", sessionId, { id })
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
    <section className={`${css.pane} ${css.split}`} aria-label={mode === "surveys" ? t("survey.title") : t("notes.title")}>
      <p className={css.lead}>{mode === "surveys" ? t("survey.hint") : t("notes.hint")}</p>
      {mode === "notes" ? (
        <div className={css.chips} role="tablist" aria-label={t("notes.title")}>
          <button type="button" className={css.chip} aria-selected={sub === "notes"} onClick={() => setSub("notes")}>
            {t("notes.notes")}
            <span>{snapshot?.notes.length ?? 0}</span>
          </button>
          <button type="button" className={css.chip} aria-selected={sub === "questions"} onClick={() => setSub("questions")}>
            {t("notes.questions")}
            <span>{snapshot?.questions.length ?? 0}</span>
          </button>
        </div>
      ) : null}
      {rows.length === 0 && !loading ? (
        <p className={css.empty}>{mode === "surveys" ? t("survey.empty") : sub === "questions" ? t("notes.questionsEmpty") : t("notes.empty")}</p>
      ) : (
        <div ref={listRef} className={css.splitList}>
          <table className={css.table}>
            <thead style={{ position: "sticky", top: 0, zIndex: 1 }}>
              <tr>
                <th>{t("docs.colTitle")}</th>
                <th className={css.colStatus}>{t("docs.colStatus")}</th>
                <th>{t("docs.colExcerpt")}</th>
              </tr>
            </thead>
            <tbody>
              {start > 0 ? <tr aria-hidden="true" style={{ height: start * ROW_HEIGHT }} /> : null}
              {visibleRows.map((row) => (
                <tr
                  key={row.id}
                  className={css.clickRow}
                  data-selected={selected === row.id || undefined}
                  onClick={() => open(row.id)}
                >
                  <td>
                    <span className={css.paperTitle}>{row.title}</span>
                    <span className={css.pathCell}>{row.path}</span>
                  </td>
                  <td><span className={css.status}>{row.meta || "—"}</span></td>
                  <td className={css.muted}>{row.excerpt || "—"}</td>
                </tr>
              ))}
              {end < rows.length ? <tr aria-hidden="true" style={{ height: (rows.length - end) * ROW_HEIGHT }} /> : null}
            </tbody>
          </table>
        </div>
      )}
      <PageReader
        page={page}
        loading={pageLoading}
        error={pageError}
        empty={t("docs.openHint")}
        t={t}
      />
    </section>
  );
}
