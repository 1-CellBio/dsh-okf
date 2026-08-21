import { isGraphNode } from "@/lib/index/rebuild";
import { listIndexableMarkdown, parseConceptRecord, toCatalogRecord } from "@/lib/index/catalog";
import { typeRank } from "@/lib/okf/concepts";
import { excerptBody } from "@/lib/graph/neighbors";
import { selectCappedGraph } from "@/lib/graph/select";
import { GRAPH_OVERVIEW_CAP } from "@/lib/graph/scale";
import { paperProcessStatus, type PaperProcess } from "@/lib/library/status";
import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { loadState, LEGACY_PIPELINE_STATE_PATH, PIPELINE_STATE_PATH } from "@/lib/pipeline/state";
import { stampEquals, stampPaths, type FileStamp } from "@/lib/index/stamps";
import type { ConceptRecord } from "@/types/okf";

export type WorkbenchPaper = {
  id: string;
  title: string;
  published?: string;
  tags: string[];
  process: PaperProcess;
};

export type WorkbenchGraph = {
  nodes: Array<{
    id: string;
    type: string;
    title: string;
    published?: string;
    tags: string[];
    excerpt: string;
    degree: number;
  }>;
  edges: Array<{ source: string; target: string }>;
  truncated: boolean;
  /** All graph-type files in the library, including claims not currently drawn. */
  total: number;
};

export type WorkbenchSnapshot = {
  papers: WorkbenchPaper[];
  graph: WorkbenchGraph;
  claimCount: number;
};

export type WorkbenchOptions = {
  includeClaims?: boolean;
  claimMinDegree?: number;
  maxNodes?: number;
};

const OVERVIEW_TYPES = new Set(["Paper", "Topic", "Method", "Entity", "Dataset", "Gene", "Pathway"]);

type WorkbenchCache = {
  optionsKey: string;
  stamps: Map<string, FileStamp>;
  snapshot: WorkbenchSnapshot;
};

/** Single-slot memo: an unchanged library reuses the last snapshot instead of
 * re-reading and re-parsing every concept file on each request. Stamps follow
 * the same per-file (size, mtimeMs) convention as the FTS index. */
let workbenchCache: WorkbenchCache | null = null;

/** Clear the memoized snapshot cache. Exported for tests. */
export function resetWorkbenchCache(): void {
  workbenchCache = null;
}

/**
 * Papers + a library graph without rebuilding FTS. Default graph omits claims.
 * When claims are included, drop those whose undirected degree is below claimMinDegree.
 */
export async function libraryWorkbench(
  store: FileStore,
  options: WorkbenchOptions = {},
): Promise<WorkbenchSnapshot> {
  const includeClaims = options.includeClaims === true;
  const minDegree = Math.max(0, options.claimMinDegree ?? 0);
  const cap = options.maxNodes ?? GRAPH_OVERVIEW_CAP;
  const optionsKey = `${includeClaims ? "1" : "0"}:${minDegree}:${cap}`;

  const listed = await listIndexableMarkdown(store);
  const paths = listed.filter((path) => {
    if (path.startsWith("claims/")) {
      return includeClaims;
    }
    return (
      path.startsWith("papers/")
      || path.startsWith("topics/")
      || path.startsWith("methods/")
      || path.startsWith("entities/")
      || path.startsWith("datasets/")
      || path.startsWith("genes/")
      || path.startsWith("pathways/")
    );
  });

  // Directory fingerprint: per-file stamps plus pipeline state, so repeated
  // requests on an unchanged library reuse the memoized snapshot instead of
  // re-reading and re-parsing every concept file.
  const statePaths: string[] = [];
  for (const candidate of [PIPELINE_STATE_PATH, LEGACY_PIPELINE_STATE_PATH]) {
    if (await store.exists(candidate)) {
      statePaths.push(candidate);
    }
  }
  const allStampPaths = [...paths, ...statePaths];
  const stampValues = await stampPaths(store, allStampPaths);
  const stamps = new Map<string, FileStamp>();
  allStampPaths.forEach((path, index) => {
    stamps.set(path, stampValues[index]!);
  });

  const cached = workbenchCache;
  if (
    cached
    && cached.optionsKey === optionsKey
    && cached.stamps.size === stamps.size
    && [...stamps.entries()].every(([path, stamp]) => {
      const old = cached.stamps.get(path);
      return old !== undefined && stampEquals(old, stamp);
    })
  ) {
    return cached.snapshot;
  }

  const snapshot = await buildSnapshot(store, includeClaims, minDegree, cap, listed, paths);
  workbenchCache = { optionsKey, stamps, snapshot };
  return snapshot;
}

async function buildSnapshot(
  store: FileStore,
  includeClaims: boolean,
  minDegree: number,
  cap: number,
  listed: string[],
  paths: string[],
): Promise<WorkbenchSnapshot> {
  const pipeline = await loadState(store);
  const claimFileCount = listed.filter((path) => path.startsWith("claims/")).length;

  const concepts = new Map<string, ConceptRecord>();
  for (const path of paths) {
    const record = parseConceptRecord(path, utf8Decode(await store.read(path)));
    if (!record || !isGraphNode(record)) {
      continue;
    }
    concepts.set(record.id, toCatalogRecord(record));
  }

  const incoming = new Map<string, number>();
  for (const record of concepts.values()) {
    for (const target of record.outgoing) {
      incoming.set(target, (incoming.get(target) ?? 0) + 1);
    }
  }
  const degreeOf = (id: string, outgoing: string[]): number =>
    outgoing.length + (incoming.get(id) ?? 0);

  const papers: WorkbenchPaper[] = [...concepts.values()]
    .filter((record) => record.type === "Paper")
    .sort((left, right) =>
      (right.published ?? "").localeCompare(left.published ?? "")
      || (left.title ?? left.id).localeCompare(right.title ?? right.id),
    )
    .map((record) => ({
      id: record.id,
      title: record.title ?? record.id,
      tags: record.tags,
      process: paperProcessStatus(record.id, pipeline),
      ...(record.published ? { published: record.published } : {}),
    }));

  const claimCount = includeClaims
    ? [...concepts.values()].filter((record) => record.type === "Claim").length
    : claimFileCount;
  const overviewCount = [...concepts.values()].filter((record) => OVERVIEW_TYPES.has(record.type)).length;
  const total = overviewCount + claimCount;

  const eligibleOverview = [...concepts.values()]
    .filter((record) => OVERVIEW_TYPES.has(record.type))
    .sort((left, right) => typeRank(left.type) - typeRank(right.type) || left.id.localeCompare(right.id));
  const eligibleClaims = includeClaims
    ? [...concepts.values()].filter(
        (record) => record.type === "Claim" && degreeOf(record.id, record.outgoing) >= minDegree,
      )
    : [];
  const { selected, truncated } = selectCappedGraph(
    eligibleOverview,
    eligibleClaims,
    cap,
    (record) => degreeOf(record.id, record.outgoing),
  );
  const ids = new Set(selected.map((record) => record.id));
  const nodes = selected.map((record) => ({
    id: record.id,
    type: record.type,
    title: record.title ?? record.id,
    tags: record.tags,
    excerpt: excerptBody(record.body, 140),
    degree: degreeOf(record.id, record.outgoing),
    ...(record.published ? { published: record.published } : {}),
  }));
  const edges: WorkbenchGraph["edges"] = [];
  for (const record of selected) {
    for (const target of record.outgoing) {
      if (!ids.has(target) || record.id === target) {
        continue;
      }
      edges.push({ source: record.id, target });
    }
  }
  return {
    papers,
    graph: { nodes, edges, truncated, total },
    claimCount,
  };
}
