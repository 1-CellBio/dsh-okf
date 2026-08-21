import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GraphCanvas } from "./GraphCanvas.tsx";
import { EMPTY_GRAPH, type GraphData } from "./graph-model.ts";
import { filterGraphData, filterPapers } from "./library-filter.ts";
import { inspectGraphNode, fileName, DIRECTION_MARK, DIRECTION_LABEL, groupInspectNeighbors } from "./inspect.ts";
import { asLegend, DEFAULT_GRAPH_TYPES, GRAPH_TYPE_FILTERS, LEGEND, legendKey } from "./graph-types.ts";
import { CoveragePane } from "./CoveragePane.tsx";
import { DocsPane } from "./DocsPane.tsx";
import { HelpPane } from "./HelpPane.tsx";
import { ReviewPane } from "./ReviewPane.tsx";
import type { OkfLocaleKey } from "./locales.ts";
import type { CoverageSnapshot, OrganizeSnapshot } from "./organize-model.ts";
import { fetchOkfJson } from "./session-fetch.ts";
import { useVirtualRows } from "./useVirtualRows.ts";
import { GRAPH_DEFAULT_MAX_NODES } from "@/lib/graph/scale.ts";
import css from "./GraphView.module.css";

type ProcessKind = "ok" | "failed" | "running" | "imported";
type Pane = "help" | "papers" | "graph" | "review" | "coverage" | "survey" | "notes";

const PANES: Array<{ id: Pane; label: OkfLocaleKey }> = [
  { id: "help", label: "help.title" },
  { id: "papers", label: "library.papersTitle" },
  { id: "graph", label: "library.graphTitle" },
  { id: "review", label: "review.title" },
  { id: "coverage", label: "coverage.title" },
  { id: "survey", label: "survey.title" },
  { id: "notes", label: "notes.title" },
];

type PaperRow = {
  id: string;
  title: string;
  published?: string;
  tags: string[];
  process: { kind: ProcessKind; status?: string; error?: string };
};

type Snapshot = {
  papers: PaperRow[];
  graph: GraphData & { truncated?: boolean; total?: number };
  claimCount: number;
};

export type GraphViewProps = {
  sessionId: string;
  t: (key: OkfLocaleKey) => string;
};

/** Session-body view: papers in this workspace plus a library graph (claims off by default). */
export function GraphView(props: GraphViewProps) {
  const { t, sessionId } = props;
  const [pane, setPane] = useState<Pane>("papers");
  const [types, setTypes] = useState<string[]>([...DEFAULT_GRAPH_TYPES]);
  const [minDegree, setMinDegree] = useState(2);
  // Raw slider value; `minDegree` above only advances after the drag settles,
  // so sliding 0→8 issues one /okf/library request instead of nine (each of
  // which would also bust the server-side snapshot cache).
  const [minDegreeInput, setMinDegreeInput] = useState(2);
  const [showShort, setShowShort] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trail, setTrail] = useState<string[]>([]);
  const [focusNonce, setFocusNonce] = useState(0);
  const pageRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [sheetBottom, setSheetBottom] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [organize, setOrganize] = useState<OrganizeSnapshot | null>(null);
  const [coverage, setCoverage] = useState<CoverageSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [organizeLoading, setOrganizeLoading] = useState(false);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const libraryPane = pane === "papers" || pane === "graph";
  const organizePane = pane === "review" || pane === "notes" || pane === "survey";
  const coveragePane = pane === "coverage";
  const helpPane = pane === "help";
  const loading = helpPane ? false : libraryPane ? libraryLoading : coveragePane ? coverageLoading : organizeLoading;
  const [paperQuery, setPaperQuery] = useState("");
  const [paperFrom, setPaperFrom] = useState("");
  const [paperTo, setPaperTo] = useState("");
  const [graphQueryInput, setGraphQueryInput] = useState("");
  const [graphQuery, setGraphQuery] = useState("");
  const [maxNodesInput, setMaxNodesInput] = useState(String(GRAPH_DEFAULT_MAX_NODES));
  const [maxNodes, setMaxNodes] = useState(GRAPH_DEFAULT_MAX_NODES);
  const [yearFromInput, setYearFromInput] = useState("");
  const [yearToInput, setYearToInput] = useState("");
  const [yearFrom, setYearFromApplied] = useState("");
  const [yearTo, setYearToApplied] = useState("");

  const includeClaims = types.includes("Claim");

  useEffect(() => {
    const timer = window.setTimeout(() => setGraphQuery(graphQueryInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [graphQueryInput]);

  // Debounce the node-cap input: empty falls back to GRAPH_DEFAULT_MAX_NODES
  // (8000, sized for a 1000-paper overview). 0 uses the server hard cap (20k).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const raw = maxNodesInput.trim();
      if (raw === "") {
        setMaxNodes(GRAPH_DEFAULT_MAX_NODES);
        return;
      }
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 0) {
        setMaxNodes(Math.floor(parsed));
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [maxNodesInput]);

  // Debounce the degree slider for the same reason as the node cap.
  useEffect(() => {
    const timer = window.setTimeout(() => setMinDegree(minDegreeInput), 300);
    return () => window.clearTimeout(timer);
  }, [minDegreeInput]);

  // Debounce year inputs: each keystroke otherwise recomputes the graph filter
  // (full adjacency rebuild) on large libraries.
  useEffect(() => {
    const timer = window.setTimeout(() => setYearFromApplied(yearFromInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [yearFromInput]);
  useEffect(() => {
    const timer = window.setTimeout(() => setYearToApplied(yearToInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [yearToInput]);

  useEffect(() => {
    if (!libraryPane) {
      return;
    }
    let cancelled = false;
    const query: Record<string, string> = {};
    if (includeClaims) {
      query.claims = "1";
      query.minDegree = String(minDegree);
    }
    if (maxNodes !== GRAPH_DEFAULT_MAX_NODES) {
      query.maxNodes = String(maxNodes);
    }
    void (async () => {
      setLibraryLoading(true);
      setError(null);
      try {
        const next = await fetchOkfJson<Snapshot>("/okf/library", sessionId, query);
        if (!cancelled) {
          setSnapshot(next);
        }
      } catch (cause: unknown) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : t("library.loadFailed"));
          // Keep the last-good snapshot so a background refresh failure
          // doesn't blank the papers/graph view.
        }
      } finally {
        if (!cancelled) {
          setLibraryLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, includeClaims, minDegree, maxNodes, tick, t, libraryPane]);

  useEffect(() => {
    if (!organizePane) {
      return;
    }
    let cancelled = false;
    void (async () => {
      setOrganizeLoading(true);
      setError(null);
      try {
        const next = await fetchOkfJson<OrganizeSnapshot>("/okf/organize", sessionId);
        if (!cancelled) {
          setOrganize(next);
        }
      } catch (cause: unknown) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : t("library.loadFailed"));
          // Keep the last-good organize snapshot on a background refresh failure.
        }
      } finally {
        if (!cancelled) {
          setOrganizeLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, tick, t, organizePane]);

  useEffect(() => {
    if (!coveragePane) {
      return;
    }
    let cancelled = false;
    void (async () => {
      setCoverageLoading(true);
      setError(null);
      try {
        const next = await fetchOkfJson<CoverageSnapshot>("/okf/coverage", sessionId);
        if (!cancelled) {
          setCoverage(next);
        }
      } catch (cause: unknown) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : t("library.loadFailed"));
          // Keep the last-good coverage snapshot on a background refresh failure.
        }
      } finally {
        if (!cancelled) {
          setCoverageLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, tick, t, coveragePane]);

  const papers = useMemo(
    () => filterPapers(snapshot?.papers ?? [], paperQuery, paperFrom, paperTo),
    [snapshot, paperQuery, paperFrom, paperTo],
  );
  // Windowing for the papers table: with 10k rows only the visible slice is
  // rendered; top/bottom spacer rows keep the scrollbar height accurate.
  const papersTableRef = useRef<HTMLDivElement>(null);
  // The table div is conditionally rendered (empty state vs table) and unmounted
  // on pane switches, so the scroll binding must follow its mount state —
  // otherwise the virtual window freezes after switching panels.
  const papersTableMounted = pane === "papers" && (papers.length > 0 || loading);
  const { start: paperStart, end: paperEnd } = useVirtualRows(papersTableRef, papersTableMounted, papers.length, 44);
  const visiblePapers = papers.slice(paperStart, paperEnd);
  const sourceGraph = snapshot?.graph ?? EMPTY_GRAPH;
  const graph = useMemo(
    () => filterGraphData(sourceGraph, {
      types,
      query: graphQuery,
      yearFrom,
      yearTo,
    }),
    [sourceGraph, types, graphQuery, yearFrom, yearTo],
  );

  const [prevSourceGraph, setPrevSourceGraph] = useState(sourceGraph);
  if (prevSourceGraph !== sourceGraph) {
    setPrevSourceGraph(sourceGraph);
    if (selectedId && !sourceGraph.nodes.some((node) => node.id === selectedId)) {
      setSelectedId(null);
      setTrail([]);
    }
  }

  useLayoutEffect(() => {
    const page = pageRef.current;
    const stage = stageRef.current;
    if (!page || !stage || pane !== "graph") {
      return;
    }
    const sync = (): void => {
      const pageBox = page.getBoundingClientRect();
      const stageBox = stage.getBoundingClientRect();
      setSheetBottom(Math.max(0, Math.round(pageBox.bottom - stageBox.bottom)));
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(page);
    observer.observe(stage);
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [pane, loading, snapshot, selectedId]);
  const count = pane === "help"
    ? t("help.badge")
    : pane === "papers"
    ? t("library.papers").replace("{n}", String(papers.length))
    : pane === "graph"
      ? `${t("graph.shown")
        .replace("{shown}", String(graph.nodes.length))
        .replace("{total}", String(snapshot?.graph.total ?? sourceGraph.nodes.length))}${
        snapshot?.graph.truncated ? t("graph.capped") : ""
      }`
      : pane === "review"
        ? t("review.items").replace("{n}", String(organize?.review.actionTotal ?? organize?.review.total ?? 0))
        : pane === "coverage"
          ? t("coverage.topics").replace("{n}", String(coverage?.topics.length ?? 0))
          : pane === "survey"
            ? t("survey.count").replace("{n}", String((organize?.surveys.length ?? 0) + (organize?.manuscripts.length ?? 0)))
            : t("notes.count").replace("{n}", String((organize?.notes.length ?? 0) + (organize?.questions.length ?? 0)));

  return (
    <section
      ref={pageRef}
      className={css.page}
      style={{ ["--okf-sheet-bottom" as string]: `${sheetBottom}px` }}
      data-conversation-composer-overlay=""
      aria-label={t("graph.title")}
    >
      <header className={css.header}>
        <div className={css.tabs} role="tablist" aria-label={t("graph.title")}>
          {PANES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={pane === item.id}
              className={css.tab}
              onClick={() => setPane(item.id)}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
        <span className={css.countBadge}>{count}</span>
        <button
          type="button"
          className={css.refresh}
          disabled={loading || pane === "help"}
          onClick={() => setTick((value) => value + 1)}
        >
          {t("library.refresh")}
        </button>
      </header>
      <div className={css.body}>
        {error && pane !== "help" ? <p className={css.error} role="alert">{error}</p> : null}
        {pane === "help" ? (
          <HelpPane t={t} />
        ) : pane === "papers" ? (
          <section className={css.pane} aria-label={t("library.papersTitle")}>
            <p className={css.lead}>{t("library.papersHint")}</p>
            <div className={css.filters}>
              <label className={css.field}>
                <span>{t("library.search")}</span>
                <input
                  className={css.input}
                  value={paperQuery}
                  placeholder={t("library.searchPlaceholder")}
                  onChange={(event) => setPaperQuery(event.target.value)}
                />
              </label>
              <label className={css.field}>
                <span>{t("library.from")}</span>
                <input
                  className={css.input}
                  value={paperFrom}
                  placeholder="YYYY-MM-DD"
                  onChange={(event) => setPaperFrom(event.target.value)}
                />
              </label>
              <label className={css.field}>
                <span>{t("library.to")}</span>
                <input
                  className={css.input}
                  value={paperTo}
                  placeholder="YYYY-MM-DD"
                  onChange={(event) => setPaperTo(event.target.value)}
                />
              </label>
            </div>
            {papers.length === 0 && !loading ? (
              <p className={css.empty}>{t("library.papersEmpty")}</p>
            ) : (
              <div ref={papersTableRef} style={{ maxHeight: "60vh", overflow: "auto" }}>
                <table className={css.table}>
                  <thead style={{ position: "sticky", top: 0, zIndex: 1 }}>
                    <tr>
                      <th className={css.colStatus}>{t("library.colStatus")}</th>
                      <th className={css.colYear}>{t("library.colYear")}</th>
                      <th>{t("library.colTitle")}</th>
                      <th className={css.colDate}>{t("library.colPublished")}</th>
                      <th>{t("library.colTags")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paperStart > 0 ? <tr aria-hidden="true" style={{ height: paperStart * 44 }} /> : null}
                    {visiblePapers.map((paper) => (
                      <tr key={paper.id}>
                        <td>
                          <span className={css.status} data-kind={paper.process.kind}>
                            {processLabel(paper.process.kind, t)}
                          </span>
                        </td>
                        <td className={css.muted}>{paper.published?.slice(0, 4) || "—"}</td>
                        <td>
                          <span className={css.paperTitle}>{paper.title}</span>
                          {paper.process.error ? (
                            <span className={css.paperError}>{paper.process.error}</span>
                          ) : null}
                        </td>
                        <td className={css.muted}>
                          {paper.published || t("library.needDate")}
                        </td>
                        <td>
                          {paper.tags.length > 0 ? (
                            <div className={css.tags}>
                              {paper.tags.map((tag) => (
                                <span key={tag} className={css.tag}>{tag}</span>
                              ))}
                            </div>
                          ) : (
                            <span className={css.muted}>—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {paperEnd < papers.length ? (
                      <tr aria-hidden="true" style={{ height: (papers.length - paperEnd) * 44 }} />
                    ) : null}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : pane === "graph" ? (
          <section className={`${css.pane} ${css.graphPane}`} aria-label={t("library.graphTitle")}>
            <div className={css.legendRow}>
              <div className={css.legend} aria-hidden="true">
                {LEGEND.map((type) => (
                  <span key={type} className={css.legendItem}>
                    <i className={css.swatch} data-type={type} />
                    {type}
                  </span>
                ))}
              </div>
              <label className={css.switch}>
                <input
                  type="checkbox"
                  checked={showShort}
                  onChange={(event) => setShowShort(event.target.checked)}
                />
                {t("graph.showShort")}
              </label>
            </div>
            <div className={css.card}>
              <div className={css.filters}>
                <label className={`${css.field} ${css.grow}`}>
                  <span>{t("graph.query")}</span>
                  <input
                    className={css.input}
                    value={graphQueryInput}
                    placeholder={t("graph.queryPlaceholder")}
                    onChange={(event) => setGraphQueryInput(event.target.value)}
                  />
                </label>
                <label className={css.fieldNarrow}>
                  <span>{t("graph.yearFrom")}</span>
                  <input
                    className={css.input}
                    inputMode="numeric"
                    placeholder="2017"
                    value={yearFromInput}
                    onChange={(event) => setYearFromInput(event.target.value)}
                  />
                </label>
                <label className={css.fieldNarrow}>
                  <span>{t("graph.yearTo")}</span>
                  <input
                    className={css.input}
                    inputMode="numeric"
                    placeholder="2026"
                    value={yearToInput}
                    onChange={(event) => setYearToInput(event.target.value)}
                  />
                </label>
                <label className={css.fieldNarrow} title={t("graph.maxNodesHint")}>
                  <span>{t("graph.maxNodes")}</span>
                  <input
                    className={css.input}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={20}
                    value={maxNodesInput}
                    placeholder={String(GRAPH_DEFAULT_MAX_NODES)}
                    onChange={(event) => setMaxNodesInput(event.target.value)}
                  />
                </label>
              </div>
              <div className={css.typeRow}>
                <div className={css.toggles} role="group" aria-label={t("graph.types")}>
                  {GRAPH_TYPE_FILTERS.map((type) => {
                    const on = types.includes(type);
                    return (
                      <button
                        key={type}
                        type="button"
                        className={css.toggle}
                        aria-pressed={on}
                        onClick={() => {
                          setTypes((current) => {
                            if (current.includes(type)) {
                              return current.length === 1 ? current : current.filter((item) => item !== type);
                            }
                            return [...current, type];
                          });
                        }}
                      >
                        <i className={css.swatch} data-type={type} />
                        {t(legendKey(type))}
                      </button>
                    );
                  })}
                </div>
                {includeClaims ? (
                  <label className={css.degree}>
                    <span>{t("library.minDegree")}</span>
                    <input
                      type="range"
                      min={0}
                      max={8}
                      value={minDegreeInput}
                      onChange={(event) => setMinDegreeInput(Number(event.target.value))}
                    />
                    <span className={css.degreeValue}>{minDegreeInput}</span>
                  </label>
                ) : null}
                <p className={css.typeCount}>{count}</p>
              </div>
            </div>
            <p className={css.hint}>{t("graph.hint")}</p>
            <div className={css.graphBody}>
              {loading && !snapshot ? (
                <p className={css.empty}>{t("library.loading")}</p>
              ) : (
                <div ref={stageRef} className={css.graphStage}>
                  <GraphCanvas
                    graph={graph}
                    fill
                    showLabels={showShort}
                    selectedId={selectedId}
                    focusNonce={focusNonce}
                    emptyLabel={t("graph.empty")}
                    fitLabel={t("library.zoomFit")}
                    relayoutLabel={t("graph.relayout")}
                    t={t}
                    onSelect={(id) => {
                      setSelectedId(id);
                      setTrail([]);
                    }}
                  />
                </div>
              )}
            </div>
          </section>
        ) : pane === "review" ? (
          <ReviewPane
            snapshot={organize}
            sessionId={sessionId}
            loading={loading}
            t={t}
            onMutated={() => setTick((n) => n + 1)}
          />
        ) : pane === "coverage" ? (
          <CoveragePane snapshot={coverage} loading={loading} t={t} />
        ) : pane === "survey" ? (
          <DocsPane key="surveys" snapshot={organize} sessionId={sessionId} loading={loading} mode="surveys" t={t} />
        ) : (
          <DocsPane key="notes" snapshot={organize} sessionId={sessionId} loading={loading} mode="notes" t={t} />
        )}
      </div>
      {pane === "graph" && selectedId ? (
        <InspectSheet
          graph={sourceGraph}
          id={selectedId}
          canGoBack={trail.length > 0}
          t={t}
          onBack={() => {
            const previous = trail[trail.length - 1];
            if (!previous) {
              return;
            }
            setTrail((current) => current.slice(0, -1));
            setSelectedId(previous);
            setFocusNonce((value) => value + 1);
          }}
          onSelect={(id) => {
            setTrail((current) => selectedId ? [...current, selectedId] : current);
            setSelectedId(id);
            setFocusNonce((value) => value + 1);
          }}
          onClose={() => {
            setSelectedId(null);
            setTrail([]);
          }}
        />
      ) : null}
    </section>
  );
}

function processLabel(kind: ProcessKind, t: GraphViewProps["t"]): string {
  if (kind === "ok") return t("library.statusOk");
  if (kind === "failed") return t("library.statusFailed");
  if (kind === "running") return t("library.statusRunning");
  return t("library.statusImported");
}

function InspectSheet(props: {
  graph: GraphData;
  id: string;
  canGoBack: boolean;
  t: GraphViewProps["t"];
  onBack: () => void;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const inspected = useMemo(() => inspectGraphNode(props.graph, props.id), [props.graph, props.id]);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);

  const [prevInspectedId, setPrevInspectedId] = useState(props.id);
  if (prevInspectedId !== props.id) {
    setPrevInspectedId(props.id);
    setQuery("");
    setCopied(false);
  }

  const onCloseRef = useRef(props.onClose);
  useEffect(() => {
    onCloseRef.current = props.onClose;
  }, [props.onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!inspected) {
    return null;
  }

  const q = query.trim().toLowerCase();
  const neighbors = q
    ? inspected.neighbors.filter((item) =>
      item.title.toLowerCase().includes(q)
      || item.id.toLowerCase().includes(q)
      || props.t(legendKey(asLegend(item.type))).includes(q),
    )
    : inspected.neighbors;
  const groups = groupInspectNeighbors(neighbors);
  const meta = [
    inspected.published || props.t("graph.noDate"),
    inspected.tags.length > 0
      ? props.t("graph.tagCount").replace("{n}", String(inspected.tags.length))
      : "",
  ].filter(Boolean).join(" · ");

  const copyId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(inspected.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <aside className={css.sheet} role="dialog" aria-label={inspected.title}>
      <header className={css.sheetHead}>
        {props.canGoBack ? (
          <button
            type="button"
            className={css.sheetBack}
            onClick={props.onBack}
            aria-label={props.t("graph.back")}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 18 9 12l6-6"
              />
            </svg>
          </button>
        ) : null}
        <span className={css.sheetType}>{props.t(legendKey(asLegend(inspected.type)))}</span>
        <button type="button" className={css.sheetClose} onClick={props.onClose} aria-label={props.t("graph.close")}>
          ×
        </button>
      </header>
      <h3 className={css.sheetTitle}>{inspected.title}</h3>
      <p className={css.sheetMeta}>{meta}</p>
      <div className={css.sheetBody}>
        <button type="button" className={css.sheetId} title={inspected.id} onClick={() => void copyId()}>
          {fileName(inspected.id)}
        </button>
        {inspected.tags.length > 0 ? (
          <div className={css.sheetTags}>
            {inspected.tags.map((tag) => (
              <span key={tag} className={css.sheetTag}>{tag}</span>
            ))}
          </div>
        ) : null}
        {inspected.excerpt ? <p className={css.sheetExcerpt}>{inspected.excerpt}</p> : null}
        <hr className={css.sheetSep} />
        <p className={css.sheetNeighborHead}>
          {props.t("graph.neighbors").replace("{n}", String(inspected.neighbors.length))}
        </p>
        {inspected.neighbors.length > 6 ? (
          <input
            className={`${css.input} ${css.sheetFilter}`}
            value={query}
            placeholder={props.t("graph.filterNeighbors")}
            aria-label={props.t("graph.filterNeighbors")}
            onChange={(event) => setQuery(event.target.value)}
          />
        ) : null}
        {groups.length === 0 ? (
          <p className={css.empty}>{props.t("graph.noNeighbors")}</p>
        ) : (
          groups.map((group) => (
            <div key={group.type} className={css.sheetGroup}>
              <p className={css.sheetGroupHead}>
                <span>{props.t(legendKey(asLegend(group.type)))}</span>
                <span>{group.items.length}</span>
              </p>
              <ul>
                {group.items.map((item) => (
                  <li key={item.id}>
                    <button type="button" className={css.sheetLink} onClick={() => props.onSelect(item.id)}>
                      <i className={css.swatch} data-type={item.type} />
                      <span>{item.title}</span>
                      <span className={css.sheetDir} title={DIRECTION_LABEL[item.direction]}>
                        {DIRECTION_MARK[item.direction]}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
      <footer className={css.sheetFoot}>
        <button type="button" className={css.sheetCopy} onClick={() => void copyId()}>
          {copied ? props.t("graph.copied") : props.t("graph.copyPath")}
        </button>
      </footer>
    </aside>
  );
}
