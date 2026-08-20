import { findDeadLinks } from "@/lib/compile/deadLinks";
import type { MergeReport } from "@/lib/bundle/merge";
import { mergeBundles } from "@/lib/bundle/merge";
import { copyPack, listPackPaths, loadPackStoreFromZip, packToZip, type PackOptions } from "@/lib/bundle/pack";
import { NodeFileStore } from "@/lib/fs/node";
import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { isGraphNode, rebuildIndex, type BundleIndex } from "@/lib/index/rebuild";
import { undirectedNeighborhood } from "@/lib/graph/filter";
import { GRAPH_NODE_TYPES } from "@/lib/okf/concepts";
import { loadSqlJs } from "@/lib/index/sqlNode";
import { syncVectors } from "@/lib/index/vectors";
import { writeNote } from "@/lib/notes/write";
import { asString } from "@/lib/okf/identity";
import { isOkfCachePath } from "@/lib/okf/cache";
import { conceptPath, extractLinks, toConceptId } from "@/lib/okf/links";
import { parseDocument } from "@/lib/okf/parse";
import { serializeDocument } from "@/lib/okf/serialize";
import { conceptSlug } from "@/lib/okf/slug";
import { isHumanVerified } from "@/lib/okf/validate";
import { excerptBody, groupNeighbors, mergeNeighbors, type NeighborLink, type NeighborRef } from "@/lib/graph/neighbors";
import { selectFairClaims } from "@/lib/graph/fairClaims";
import { loadState } from "@/lib/pipeline/state";
import { refreshRootIndex } from "@/lib/pipeline/log";
import { listCoverageGaps } from "@/lib/coverage/gaps";
import { buildCoverageMatrix } from "@/lib/coverage/matrix";
import type { ChatClient, EmbeddingClient } from "@/lib/providers/types";
import { OpenAICompatibleEmbeddings } from "@/lib/providers/embeddings";
import { retrieve, queryVectorHits } from "@/lib/retrieve/query";
import { bibtexForSurvey, compileSurvey } from "@/lib/survey/run";
import { citeCheck } from "@/lib/survey/citeCheck";
import { exportSurveyManuscript, type CiteStyle } from "@/lib/survey/exportManuscript";
import type { ConceptRecord, Frontmatter } from "@/types/okf";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { sameResolvedPath, surveyStorePath } from "./paths";

const SEARCH_HIT_LIMIT = 16;
const EXTRACT_BODY_CAP = 1_200;
const CONCEPT_BODY_CAP = 4_000;
const OUTGOING_CAP = 12;
const LIBRARY_GRAPH_NODE_CAP = 48;
const LIBRARY_GRAPH_EDGE_CAP = 80;
const COMPARE_PAPER_CAP = 24;
const COMPARE_EXPLICIT_CAP = 48;
const COMPARE_NEIGHBOR_CAP = 12;
const COMPARE_SHARED_CAP = 24;
const STATS_TOP = 16;
const EVIDENCE_CAP = 12;

// Process-level memo: the MCP server is long-lived and calls loadBundleIndex on
// nearly every tool. Without caching, each okf_search / okf_compare / okf_stats
// re-reads fts.sqlite and re-loads every concept and every chunk embedding,
// which is the dominant latency at 10k scale. The cache is keyed by the
// library root (FileStore.root, falling back to the store instance) and
// invalidated explicitly after writes. openSession() creates a fresh FileStore
// per call, so keying by instance identity would never hit; keying by root lets
// every session of the same library share one index.
const bundleIndexCache = new Map<string | FileStore, BundleIndex>();

function bundleIndexKey(store: FileStore): string | FileStore {
  return store.root ?? store;
}

export async function loadBundleIndex(store: FileStore): Promise<BundleIndex> {
  const key = bundleIndexKey(store);
  const cached = bundleIndexCache.get(key);
  if (cached) {
    return cached;
  }
  const index = await buildIndex(store);
  bundleIndexCache.set(key, index);
  return index;
}

function disposeIndex(index: BundleIndex): void {
  try {
    index.search.dispose?.();
  } catch {
    // Best-effort: a failing dispose must not break the rebuild path.
  }
}

export function invalidateBundleIndex(store?: FileStore): void {
  if (!store) {
    for (const index of bundleIndexCache.values()) {
      disposeIndex(index);
    }
    bundleIndexCache.clear();
    return;
  }
  // Invalidate only the touched library so other sessions keep their warm
  // index instead of paying a full rebuild on their next read.
  const key = bundleIndexKey(store);
  const index = bundleIndexCache.get(key);
  if (index) {
    disposeIndex(index);
    bundleIndexCache.delete(key);
  }
}

async function buildIndex(store: FileStore): Promise<BundleIndex> {
  try {
    const sql = await loadSqlJs();
    return rebuildIndex(store, { sql, persist: true });
  } catch {
    return rebuildIndex(store);
  }
}

/**
 * Semantic (vector) search is opt-in via the KG_EMBED_* env vars. Returns
 * undefined when no embedding model is configured, so every caller falls back
 * to FTS-only with no extra network work.
 */
function embeddingClient(): EmbeddingClient | undefined {
  const model = (process.env.KG_EMBED_MODEL ?? process.env.OPENAI_EMBED_MODEL ?? "").trim();
  if (!model) {
    return undefined;
  }
  const baseUrl = (
    process.env.KG_EMBED_BASE_URL ??
    process.env.OPENAI_EMBED_BASE_URL ??
    process.env.KG_BASE_URL ??
    process.env.OPENAI_BASE_URL ??
    ""
  ).trim();
  if (!baseUrl) {
    return undefined;
  }
  const apiKey =
    process.env.KG_EMBED_API_KEY ??
    process.env.OPENAI_EMBED_API_KEY ??
    process.env.KG_API_KEY ??
    process.env.OPENAI_API_KEY ??
    "";
  return new OpenAICompatibleEmbeddings({ model, baseUrl, apiKey });
}

export async function syncVectorsOp(
  store: FileStore,
): Promise<{ model: string; chunks: number; changed: number }> {
  const embed = embeddingClient();
  if (!embed) {
    throw new Error(
      "No embedding model configured. Set KG_EMBED_MODEL (plus KG_EMBED_BASE_URL / KG_EMBED_API_KEY) in the environment, then retry.",
    );
  }
  const sql = await loadSqlJs();
  const result = await syncVectors(store, sql, embed, { model: embed.model ?? "", persist: true });
  // The bundle index memo holds a vector-less snapshot; drop it so the next
  // load re-reads vectors.sqlite and semantic hits become available.
  invalidateBundleIndex(store);
  return result;
}

export function allowedCiteIds(index: BundleIndex): string[] {
  return [...index.concepts.values()]
    .filter((record) => record.type === "Paper" || record.type === "Claim")
    .map((record) => record.id);
}

export async function searchOkf(
  store: FileStore,
  query: string,
  type?: string,
  options: { from?: string; to?: string; tags?: string[] } = {},
): Promise<{
  hits: Array<{
    id: string;
    type: string;
    title: string;
    path: string;
    published?: string;
    paper?: string;
    outgoing: string[];
  }>;
}> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("okf_search requires query");
  }
  const wanted = type?.trim() || undefined;
  const index = await loadBundleIndex(store);
  const vectorHits = await queryVectorHits(index, embeddingClient(), trimmed);
  const raw = retrieve(index, {
    text: trimmed,
    type: wanted === "TextExtract" ? "TextExtract" : undefined,
    publishedFrom: options.from?.trim() || undefined,
    publishedTo: options.to?.trim() || undefined,
    tags: options.tags?.filter((tag) => tag.trim() !== "") || undefined,
    ...(vectorHits ? { vectorHits } : {}),
  });
  const hits: Array<{
    id: string;
    type: string;
    title: string;
    path: string;
    published?: string;
    paper?: string;
    outgoing: string[];
  }> = [];
  const seen = new Set<string>();
  for (const record of raw) {
    let target = record;
    if (wanted !== "TextExtract" && record.type === "TextExtract") {
      if (!record.paper) {
        continue;
      }
      const paper = index.concepts.get(record.paper);
      if (!paper) {
        continue;
      }
      target = paper;
    }
    if (wanted && target.type !== wanted) {
      continue;
    }
    if (seen.has(target.id)) {
      continue;
    }
    seen.add(target.id);
    hits.push({
      id: target.id,
      type: target.type,
      title: target.title ?? target.id,
      path: target.path,
      outgoing: target.outgoing.slice(0, OUTGOING_CAP),
      ...(target.published ? { published: target.published } : {}),
      ...(target.paper ? { paper: target.paper } : {}),
    });
    if (hits.length >= SEARCH_HIT_LIMIT) {
      break;
    }
  }
  return { hits };
}

export async function getConcept(
  store: FileStore,
  id: string,
  options: { full?: boolean } = {},
): Promise<{
  id: string;
  path: string;
  type?: string;
  title?: string;
  frontmatter: Frontmatter;
  body: string;
  truncated: boolean;
  outgoing: string[];
}> {
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error("okf_get requires id");
  }
  const pathKey = conceptPath(trimmed);
  refuseOpaquePath(pathKey);
  if (!(await store.exists(pathKey))) {
    throw new Error(`Concept not found: ${toConceptId(trimmed)}`);
  }
  const doc = parseDocument(utf8Decode(await store.read(pathKey)));
  const type = asString(doc.frontmatter.type);
  const paper = asString(doc.frontmatter.paper);
  if (type === "TextExtract" && options.full !== true) {
    const hint = paper
      ? `Read ${toConceptId(paper)} instead, or okf_evidence. Pass full=true only for a ${EXTRACT_BODY_CAP}-character extract window.`
      : `Use okf_search / okf_evidence. Pass full=true only for a ${EXTRACT_BODY_CAP}-character extract window.`;
    throw new Error(`okf_get does not dump extracts/*.md. ${hint}`);
  }
  let body = doc.body;
  let truncated = false;
  const cap = type === "TextExtract" ? EXTRACT_BODY_CAP : CONCEPT_BODY_CAP;
  const allowLong = options.full === true && type !== "TextExtract";
  if (!allowLong && body.length > cap) {
    body = `${body.slice(0, cap)}\n\n… truncated. Pass full=true for this one page (max 1–2 okf_get per turn).`;
    truncated = true;
  }
  return {
    id: toConceptId(pathKey),
    path: pathKey,
    type,
    title: asString(doc.frontmatter.title),
    frontmatter: doc.frontmatter,
    body,
    truncated,
    outgoing: extractLinks(doc.body, pathKey).slice(0, OUTGOING_CAP),
  };
}

export type CompareRef = { id: string; title: string };

/**
 * Who cites a concept: every node whose body links to `id` (papers, claims,
 * topics, methods, entities, datasets, genes, pathways, notes, …). Reads the
 * cached reverse-edge map so the cost is one map lookup, not a library walk.
 */
export async function backlinksOp(
  store: FileStore,
  id: string,
  options: { type?: string } = {},
): Promise<{
  id: string;
  title?: string;
  type?: string;
  backlinks: Array<{ id: string; type?: string; title?: string; paper?: string }>;
}> {
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error("okf_backlinks requires id");
  }
  const pathKey = conceptPath(trimmed);
  refuseOpaquePath(pathKey);
  const index = await loadBundleIndex(store);
  const record = index.concepts.get(toConceptId(pathKey));
  if (!record) {
    throw new Error(`Concept not found: ${toConceptId(trimmed)}`);
  }
  const wanted = options.type?.trim() || undefined;
  const backlinks = (incomingOf(index).get(record.id) ?? [])
    .map((sid) => index.concepts.get(sid))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .filter((r) => !wanted || r.type === wanted)
    .map((r) => ({
      id: r.id,
      ...(r.title ? { title: r.title } : {}),
      ...(r.type ? { type: r.type } : {}),
      ...(r.paper ? { paper: r.paper } : {}),
    }))
    .sort((left, right) => (left.title ?? left.id).localeCompare(right.title ?? right.id));
  return {
    id: record.id,
    ...(record.title ? { title: record.title } : {}),
    ...(record.type ? { type: record.type } : {}),
    backlinks,
  };
}

/**
 * Direct neighbors of one concept, split into outgoing / incoming and grouped
 * by type. Uses the cached reverse-edge map; multi-hop expansion is served by
 * okf_graph(id, depth) instead.
 */
export async function neighborsOp(
  store: FileStore,
  id: string,
  options: { type?: string } = {},
): Promise<{
  id: string;
  title?: string;
  type?: string;
  outgoing: NeighborRef[];
  incoming: NeighborRef[];
  groups: Array<{ type: string; items: NeighborLink[] }>;
}> {
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error("okf_neighbors requires id");
  }
  const pathKey = conceptPath(trimmed);
  refuseOpaquePath(pathKey);
  const index = await loadBundleIndex(store);
  const record = index.concepts.get(toConceptId(pathKey));
  if (!record) {
    throw new Error(`Concept not found: ${toConceptId(trimmed)}`);
  }
  const wanted = options.type?.trim() || undefined;
  const incoming = incomingOf(index);
  const toRef = (r: ConceptRecord): NeighborRef => ({ id: r.id, title: r.title ?? r.id, type: r.type });
  let outgoing = record.outgoing
    .map((target) => index.concepts.get(target))
    .filter((r): r is ConceptRecord => r !== undefined);
  let back = (incoming.get(record.id) ?? [])
    .map((source) => index.concepts.get(source))
    .filter((r): r is ConceptRecord => r !== undefined);
  if (wanted) {
    outgoing = outgoing.filter((r) => r.type === wanted);
    back = back.filter((r) => r.type === wanted);
  }
  const sortRefs = (items: NeighborRef[]): NeighborRef[] =>
    [...items].sort((a, b) => a.title.localeCompare(b.title));
  return {
    id: record.id,
    ...(record.title ? { title: record.title } : {}),
    ...(record.type ? { type: record.type } : {}),
    outgoing: sortRefs(outgoing.map(toRef)),
    incoming: sortRefs(back.map(toRef)),
    groups: groupNeighbors(mergeNeighbors(outgoing.map(toRef), back.map(toRef))),
  };
}

export type ComparePaperCard = {
  id: string;
  title: string;
  published?: string;
  tags: string[];
  excerpt: string;
  topics: CompareRef[];
  methods: CompareRef[];
  entities: CompareRef[];
  datasets: CompareRef[];
  genes: CompareRef[];
  pathways: CompareRef[];
  claimCount: number;
};

export type CompareSharedHit = CompareRef & { papers: string[] };

/** Concept hub types compared across papers (datasets/genes/pathways included). */
const COMPARE_HUB_TYPES = ["Topic", "Method", "Entity", "Dataset", "Gene", "Pathway"] as const;
type CompareHubField = "topics" | "methods" | "entities" | "datasets" | "genes" | "pathways";
const COMPARE_HUB_FIELDS: Record<(typeof COMPARE_HUB_TYPES)[number], CompareHubField> = {
  Topic: "topics",
  Method: "methods",
  Entity: "entities",
  Dataset: "datasets",
  Gene: "genes",
  Pathway: "pathways",
};

/**
 * Compact multi-paper briefing from the index. Shared topics/methods/entities/tags
 * without dumping paper bodies — use okf_get only when a specific page is needed.
 */
export async function comparePapersOp(
  store: FileStore,
  input: { papers?: string[]; query?: string } = {},
): Promise<{
  papers: ComparePaperCard[];
  shared: {
    tags: Array<{ tag: string; papers: string[] }>;
    topics: CompareSharedHit[];
    methods: CompareSharedHit[];
    entities: CompareSharedHit[];
    datasets: CompareSharedHit[];
    genes: CompareSharedHit[];
    pathways: CompareSharedHit[];
  };
  inAll: {
    tags: string[];
    topics: CompareRef[];
    methods: CompareRef[];
    entities: CompareRef[];
    datasets: CompareRef[];
    genes: CompareRef[];
    pathways: CompareRef[];
  };
  missing: string[];
  truncated: boolean;
  nodes: Array<{ id: string; type: string; title: string }>;
  edges: Array<{ source: string; target: string }>;
}> {
  const index = await loadBundleIndex(store);
  const requested = (input.papers ?? []).map((id) => toConceptId(conceptPath(id.trim()))).filter(Boolean);
  const query = input.query?.trim() ?? "";
  const allPapers = [...index.concepts.values()]
    .filter((record) => record.type === "Paper")
    .sort((left, right) =>
      (right.published ?? "").localeCompare(left.published ?? "")
      || left.id.localeCompare(right.id),
    );
  let truncated = false;
  let selected = allPapers;
  const missing: string[] = [];
  if (requested.length > 0) {
    const seen = new Set<string>();
    selected = [];
    for (const id of requested) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const record = index.concepts.get(id);
      if (!record || record.type !== "Paper") {
        missing.push(id);
        continue;
      }
      selected.push(record);
    }
    if (selected.length > COMPARE_EXPLICIT_CAP) {
      truncated = true;
      selected = selected.slice(0, COMPARE_EXPLICIT_CAP);
    }
  } else if (query) {
    selected = papersFromQuery(index, query);
    if (selected.length > COMPARE_PAPER_CAP) {
      truncated = true;
      selected = selected.slice(0, COMPARE_PAPER_CAP);
    }
    if (selected.length === 0) {
      throw new Error("okf_compare query matched no papers. Use okf_search or okf_stats.");
    }
  } else if (selected.length > COMPARE_PAPER_CAP) {
    throw new Error(
      `Library has ${selected.length} papers. Use okf_stats for a census, okf_evidence to gather claims, or pass query/papers to okf_compare (max ${COMPARE_PAPER_CAP}).`,
    );
  }

  const incoming = incomingOf(index);
  const cards: ComparePaperCard[] = selected.map((paper) => {
    const hubs: Record<CompareHubField, CompareRef[]> = {
      topics: [],
      methods: [],
      entities: [],
      datasets: [],
      genes: [],
      pathways: [],
    };
    for (const hubType of COMPARE_HUB_TYPES) {
      hubs[COMPARE_HUB_FIELDS[hubType]] = neighborsOf(index, incoming, paper.id, hubType)
        .slice(0, COMPARE_NEIGHBOR_CAP)
        .map(toRef);
    }
    return {
      id: paper.id,
      title: paper.title ?? paper.id,
      tags: paper.tags,
      excerpt: excerptBody(paper.body, 220),
      ...hubs,
      claimCount: claimCountFor(index, incoming, paper.id),
      ...(paper.published ? { published: paper.published } : {}),
    };
  });

  const paperIds = cards.map((card) => card.id);
  const sharedHub: Record<CompareHubField, CompareSharedHit[]> = {
    topics: [],
    methods: [],
    entities: [],
    datasets: [],
    genes: [],
    pathways: [],
  };
  for (const hubType of COMPARE_HUB_TYPES) {
    sharedHub[COMPARE_HUB_FIELDS[hubType]] = sharedHits(cards, COMPARE_HUB_FIELDS[hubType], paperIds.length);
  }
  const tagMap = new Map<string, { tag: string; papers: string[] }>();
  for (const card of cards) {
    for (const tag of card.tags) {
      const key = tag.toLowerCase();
      const current = tagMap.get(key) ?? { tag, papers: [] };
      if (!current.papers.includes(card.id)) {
        current.papers.push(card.id);
      }
      tagMap.set(key, current);
    }
  }
  const sharedTags = [...tagMap.values()]
    .filter((item) => item.papers.length >= 2)
    .sort((left, right) => right.papers.length - left.papers.length || left.tag.localeCompare(right.tag))
    .slice(0, COMPARE_SHARED_CAP);

  const inAllCount = paperIds.length;
  const inAll = {
    tags: sharedTags.filter((item) => item.papers.length === inAllCount).map((item) => item.tag),
    topics: sharedHub.topics.filter((item) => item.papers.length === inAllCount).map(toRef),
    methods: sharedHub.methods.filter((item) => item.papers.length === inAllCount).map(toRef),
    entities: sharedHub.entities.filter((item) => item.papers.length === inAllCount).map(toRef),
    datasets: sharedHub.datasets.filter((item) => item.papers.length === inAllCount).map(toRef),
    genes: sharedHub.genes.filter((item) => item.papers.length === inAllCount).map(toRef),
    pathways: sharedHub.pathways.filter((item) => item.papers.length === inAllCount).map(toRef),
  };

  const nodes: Array<{ id: string; type: string; title: string }> = cards.map((card) => ({
    id: card.id,
    type: "Paper",
    title: card.title,
  }));
  const edges: Array<{ source: string; target: string }> = [];
  const addNode = (ref: CompareRef, type: string): void => {
    if (!nodes.some((node) => node.id === ref.id)) {
      nodes.push({ id: ref.id, type, title: ref.title });
    }
  };
  const allShared = [...sharedHub.topics, ...sharedHub.methods, ...sharedHub.entities, ...sharedHub.datasets, ...sharedHub.genes, ...sharedHub.pathways];
  for (const hit of allShared.slice(0, LIBRARY_GRAPH_NODE_CAP)) {
    const type = COMPARE_HUB_TYPES.find((hubType) => sharedHub[COMPARE_HUB_FIELDS[hubType]].includes(hit));
    if (type) {
      addNode(hit, type);
    }
    for (const paper of hit.papers) {
      edges.push({ source: paper, target: hit.id });
    }
  }

  return {
    papers: cards,
    shared: {
      tags: sharedTags,
      topics: sharedHub.topics.slice(0, COMPARE_SHARED_CAP),
      methods: sharedHub.methods.slice(0, COMPARE_SHARED_CAP),
      entities: sharedHub.entities.slice(0, COMPARE_SHARED_CAP),
      datasets: sharedHub.datasets.slice(0, COMPARE_SHARED_CAP),
      genes: sharedHub.genes.slice(0, COMPARE_SHARED_CAP),
      pathways: sharedHub.pathways.slice(0, COMPARE_SHARED_CAP),
    },
    inAll,
    missing,
    truncated,
    nodes: nodes.slice(0, LIBRARY_GRAPH_NODE_CAP),
    edges: edges.slice(0, LIBRARY_GRAPH_EDGE_CAP),
  };
}

function toRef(record: { id: string; title?: string } | CompareRef): CompareRef {
  return { id: record.id, title: record.title ?? record.id };
}

/**
 * Derived per-index data (reverse edges, claim grouping, type buckets,
 * paper-degree). Built lazily once per BundleIndex and memoized on the index
 * object, so the four ops that need reverse edges (stats/check/graph/compare)
 * stop re-walking the whole concept map on every call. A rebuilt index is a
 * fresh object, so the WeakMap invalidates itself.
 */
type DerivedIndex = {
  incoming: Map<string, string[]>;
  claimsByPaper: Map<string, Set<string>>;
  paperLinks: Map<string, Set<string>>;
  byType: Map<string, ConceptRecord[]>;
};

const derivedIndexCache = new WeakMap<BundleIndex, DerivedIndex>();

function derivedOf(index: BundleIndex): DerivedIndex {
  const cached = derivedIndexCache.get(index);
  if (cached) {
    return cached;
  }
  const incoming = new Map<string, string[]>();
  const claimsByPaper = new Map<string, Set<string>>();
  const paperLinks = new Map<string, Set<string>>();
  const byType = new Map<string, ConceptRecord[]>();
  const addPaperLink = (id: string, paper: string): void => {
    const set = paperLinks.get(id) ?? new Set<string>();
    set.add(paper);
    paperLinks.set(id, set);
  };
  for (const record of index.concepts.values()) {
    const bucket = byType.get(record.type) ?? [];
    bucket.push(record);
    byType.set(record.type, bucket);
    if (record.type === "Claim" && record.paper) {
      const claims = claimsByPaper.get(record.paper) ?? new Set<string>();
      claims.add(record.id);
      claimsByPaper.set(record.paper, claims);
    }
    for (const target of record.outgoing) {
      const list = incoming.get(target) ?? [];
      list.push(record.id);
      incoming.set(target, list);
      if (index.concepts.get(target)?.type === "Paper") {
        addPaperLink(record.id, target);
      }
    }
    if (record.type === "Paper") {
      for (const target of record.outgoing) {
        addPaperLink(target, record.id);
      }
    }
  }
  const derived: DerivedIndex = { incoming, claimsByPaper, paperLinks, byType };
  derivedIndexCache.set(index, derived);
  return derived;
}

function incomingOf(index: BundleIndex): Map<string, string[]> {
  return derivedOf(index).incoming;
}

function neighborsOf(
  index: BundleIndex,
  incoming: Map<string, string[]>,
  paperId: string,
  type: string,
): Array<{ id: string; title?: string }> {
  const ids = new Set<string>();
  const paper = index.concepts.get(paperId);
  for (const target of paper?.outgoing ?? []) {
    const record = index.concepts.get(target);
    if (record?.type === type) {
      ids.add(record.id);
    }
  }
  for (const source of incoming.get(paperId) ?? []) {
    const record = index.concepts.get(source);
    if (record?.type === type) {
      ids.add(record.id);
    }
  }
  return [...ids]
    .map((id) => index.concepts.get(id))
    .filter((record): record is NonNullable<typeof record> => record !== undefined)
    .sort((left, right) => (left.title ?? left.id).localeCompare(right.title ?? right.id));
}

function claimCountFor(
  index: BundleIndex,
  incoming: Map<string, string[]>,
  paperId: string,
): number {
  const ids = new Set<string>();
  const paper = index.concepts.get(paperId);
  for (const target of paper?.outgoing ?? []) {
    if (index.concepts.get(target)?.type === "Claim") {
      ids.add(target);
    }
  }
  for (const source of incoming.get(paperId) ?? []) {
    if (index.concepts.get(source)?.type === "Claim") {
      ids.add(source);
    }
  }
  // Claims carry an explicit paper field (not just graph edges), so union the
  // pre-grouped claim index instead of re-walking every concept in the library.
  for (const id of derivedOf(index).claimsByPaper.get(paperId) ?? []) {
    ids.add(id);
  }
  return ids.size;
}

function sharedHits(
  cards: ComparePaperCard[],
  field: CompareHubField,
  paperCount: number,
): CompareSharedHit[] {
  if (paperCount < 2) {
    return [];
  }
  const map = new Map<string, CompareSharedHit>();
  for (const card of cards) {
    for (const ref of card[field]) {
      const current = map.get(ref.id) ?? { ...ref, papers: [] };
      if (!current.papers.includes(card.id)) {
        current.papers.push(card.id);
      }
      map.set(ref.id, current);
    }
  }
  return [...map.values()]
    .filter((item) => item.papers.length >= 2)
    .sort((left, right) => right.papers.length - left.papers.length || left.title.localeCompare(right.title));
}

function papersFromQuery(index: BundleIndex, query: string): ConceptRecord[] {
  const ids = new Set<string>();
  const addPaper = (id: string | undefined): void => {
    if (!id) {
      return;
    }
    const record = index.concepts.get(id);
    if (record?.type === "Paper") {
      ids.add(record.id);
    }
  };
  for (const hit of retrieve(index, { text: query })) {
    addPaper(hit.id);
    addPaper(hit.paper);
    for (const target of hit.outgoing) {
      addPaper(target);
    }
  }
  return [...ids]
    .map((id) => index.concepts.get(id))
    .filter((record): record is ConceptRecord => record?.type === "Paper");
}

export async function libraryStatsOp(store: FileStore): Promise<{
  counts: Record<string, number>;
  years: Array<{ year: string; papers: number }>;
  topics: Array<CompareRef & { papers: number }>;
  methods: Array<CompareRef & { papers: number }>;
  entities: Array<CompareRef & { papers: number }>;
  datasets: Array<CompareRef & { papers: number }>;
  genes: Array<CompareRef & { papers: number }>;
  pathways: Array<CompareRef & { papers: number }>;
  tags: Array<{ tag: string; papers: number }>;
}> {
  const index = await loadBundleIndex(store);
  const incoming = incomingOf(index);
  const counts: Record<string, number> = {};
  const yearMap = new Map<string, number>();
  const tagMap = new Map<string, Set<string>>();
  for (const record of index.concepts.values()) {
    counts[record.type] = (counts[record.type] ?? 0) + 1;
    if (record.type !== "Paper") {
      continue;
    }
    const year = record.published?.slice(0, 4);
    if (year) {
      yearMap.set(year, (yearMap.get(year) ?? 0) + 1);
    }
    for (const tag of record.tags) {
      const key = tag.toLowerCase();
      const papers = tagMap.get(key) ?? new Set<string>();
      papers.add(record.id);
      tagMap.set(key, papers);
    }
  }
  return {
    counts,
    years: [...yearMap.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([year, papers]) => ({ year, papers })),
    topics: rankedHubs(index, incoming, "Topic"),
    methods: rankedHubs(index, incoming, "Method"),
    entities: rankedHubs(index, incoming, "Entity"),
    datasets: rankedHubs(index, incoming, "Dataset"),
    genes: rankedHubs(index, incoming, "Gene"),
    pathways: rankedHubs(index, incoming, "Pathway"),
    tags: [...tagMap.entries()]
      .map(([tag, papers]) => ({ tag, papers: papers.size }))
      .sort((left, right) => right.papers - left.papers || left.tag.localeCompare(right.tag))
      .slice(0, STATS_TOP),
  };
}

export type LibraryCheckIssue = {
  severity: "error" | "warning";
  category: "dead_link" | "isolated" | "claim_only" | "isolated_concept" | "unreferenced" | "pipeline";
  path?: string;
  scope?: string;
  message: string;
};

export async function libraryCheckOp(store: FileStore): Promise<{
  ok: boolean;
  summary: {
    papers: number;
    concepts: number;
    deadLinks: number;
    isolatedPapers: number;
    claimOnlyPapers: number;
    isolatedConcepts: number;
    unreferencedConcepts: number;
    pipeline: { total: number; incomplete: number; unrecordedPdfs: number };
  };
  issues: LibraryCheckIssue[];
}> {
  const issues: LibraryCheckIssue[] = [];
  const index = await loadBundleIndex(store);
  const incoming = incomingOf(index);
  const graphTypes = new Set(["Paper", "Claim", "Topic", "Method", "Entity", "Dataset", "Gene", "Pathway"]);

  // 1. Dead internal links across the whole library. A link is dead when its
  //    target is neither an indexed concept nor any other file on disk. The
  //    index paths are passed as known targets so only non-indexed targets
  //    need a store.exists probe.
  const knownPaths = [...index.concepts.values()].map((record) => record.path);
  const bodies = [...index.concepts.values()]
    .filter((record) => graphTypes.has(record.type))
    .map((record) => ({ body: record.body, scope: `${record.type}:${record.id}` }));
  const deadLinks = await findDeadLinks(store, bodies, knownPaths);
  for (const link of deadLinks) {
    issues.push({
      severity: "error",
      category: "dead_link",
      scope: link.scope,
      message: `${link.href} (${link.label || "no label"})`,
    });
  }

  // 2. Isolated papers: no outgoing and no incoming edge to any existing node.
  //    These render as a lone "论文" node in the graph. Papers that only connect
  //    via Claim nodes (no Topic/Method/Entity/Dataset/Gene/Pathway/Paper edge)
  //    render as a lone node too whenever claims are hidden, so flag those as a
  //    warning as well.
  let isolatedPapers = 0;
  let claimOnlyPapers = 0;
  for (const record of index.concepts.values()) {
    if (record.type !== "Paper") {
      continue;
    }
    const out = (record.outgoing ?? []).filter((target) => target !== record.id && index.concepts.has(target));
    const inEdges = (incoming.get(record.id) ?? []).filter((source) => source !== record.id && index.concepts.has(source));
    const all = [...out, ...inEdges];
    if (all.length === 0) {
      isolatedPapers += 1;
      issues.push({
        severity: "error",
        category: "isolated",
        path: record.path,
        message: `Paper "${record.title ?? record.id}" has no edges to any other node`,
      });
      continue;
    }
    const hubEdges = all.filter((id) => index.concepts.get(id)?.type !== "Claim");
    if (hubEdges.length === 0) {
      claimOnlyPapers += 1;
      issues.push({
        severity: "warning",
        category: "claim_only",
        path: record.path,
        message: `Paper "${record.title ?? record.id}" connects only via Claim nodes — it renders as a lone node when claims are hidden`,
      });
    }
  }

  // 2b. Isolated / unreferenced concept nodes (Topic/Method/Entity/Dataset/
  //     Gene/Pathway). A node is "isolated" when no page links to or from it;
  //     it is "unreferenced" when it only links out but nothing links to it.
  //     Both render as a floating concept in the graph, so report them the same
  //     way isolated papers are reported.
  const hubNodeTypes = new Set<string>(GRAPH_NODE_TYPES.filter((type) => type !== "Paper" && type !== "Claim"));
  let isolatedConcepts = 0;
  let unreferencedConcepts = 0;
  for (const record of index.concepts.values()) {
    if (!hubNodeTypes.has(record.type)) {
      continue;
    }
    const out = (record.outgoing ?? []).filter((target) => target !== record.id && index.concepts.has(target));
    const inEdges = (incoming.get(record.id) ?? []).filter((source) => source !== record.id && index.concepts.has(source));
    if (out.length === 0 && inEdges.length === 0) {
      isolatedConcepts += 1;
      issues.push({
        severity: "error",
        category: "isolated_concept",
        path: record.path,
        message: `${record.type} "${record.title ?? record.id}" has no edges to or from any other node`,
      });
      continue;
    }
    if (inEdges.length === 0) {
      unreferencedConcepts += 1;
      issues.push({
        severity: "warning",
        category: "unreferenced",
        path: record.path,
        message: `${record.type} "${record.title ?? record.id}" is never referenced by any other page (outgoing links only)`,
      });
    }
  }

  // 3. PDF pipeline completeness: records that are not done, done records whose
  //    compiled paper file vanished, and PDFs on disk never recorded by ingest.
  const state = await loadState(store);
  const entries = Object.entries(state.pdfs);
  let incomplete = 0;
  for (const [sourcePath, record] of entries) {
    if (record.status === "done") {
      if (record.paper && !(await store.exists(record.paper))) {
        incomplete += 1;
        issues.push({
          severity: "error",
          category: "pipeline",
          path: sourcePath,
          message: `status=done but compiled paper ${record.paper} is missing from disk`,
        });
      }
      continue;
    }
    incomplete += 1;
    issues.push({
      severity: record.status === "failed" || record.status === "compile_failed" ? "error" : "warning",
      category: "pipeline",
      path: sourcePath,
      message: `status=${record.status}${record.error ? ` (${record.error})` : ""}`,
    });
  }
  const recordedPaths = new Set(entries.map(([sourcePath]) => sourcePath));
  let unrecordedPdfs = 0;
  for (const pdfPath of await store.list("sources/pdfs")) {
    if (!/\.pdf$/i.test(pdfPath) || recordedPaths.has(pdfPath)) {
      continue;
    }
    unrecordedPdfs += 1;
    issues.push({
      severity: "warning",
      category: "pipeline",
      path: pdfPath,
      message: "PDF present in sources/pdfs but absent from the ingest pipeline",
    });
  }

  return {
    ok: issues.length === 0,
    summary: {
      papers: [...index.concepts.values()].filter((record) => record.type === "Paper").length,
      concepts: index.concepts.size,
      deadLinks: deadLinks.length,
      isolatedPapers,
      claimOnlyPapers,
      isolatedConcepts,
      unreferencedConcepts,
      pipeline: { total: entries.length + unrecordedPdfs, incomplete, unrecordedPdfs },
    },
    issues,
  };
}

export async function gatherEvidenceOp(
  store: FileStore,
  query: string,
): Promise<{
  query: string;
  claims: Array<{
    id: string;
    title: string;
    paper?: string;
    paperTitle?: string;
    stance?: string;
    confidence?: string;
    excerpt: string;
  }>;
  papers: Array<{ id: string; title: string; claims: number }>;
}> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("okf_evidence requires query");
  }
  const index = await loadBundleIndex(store);
  const vectorHits = await queryVectorHits(index, embeddingClient(), trimmed);
  let claims = retrieve(index, {
    text: trimmed,
    type: "Claim",
    ...(vectorHits ? { vectorHits } : {}),
  }).slice(0, EVIDENCE_CAP);
  if (claims.length === 0) {
    claims = retrieve(index, { text: trimmed, ...(vectorHits ? { vectorHits } : {}) })
      .filter((record) => record.type === "Claim")
      .slice(0, EVIDENCE_CAP);
  }
  const paperHits = new Map<string, number>();
  const rows = claims.map((claim) => {
    if (claim.paper) {
      paperHits.set(claim.paper, (paperHits.get(claim.paper) ?? 0) + 1);
    }
    const paperTitle = claim.paper ? index.concepts.get(claim.paper)?.title : undefined;
    return {
      id: claim.id,
      title: claim.title ?? claim.id,
      excerpt: excerptBody(claim.body, 180),
      ...(claim.paper ? { paper: claim.paper } : {}),
      ...(paperTitle ? { paperTitle } : {}),
      ...(claim.stance ? { stance: claim.stance } : {}),
      ...(claim.confidence ? { confidence: claim.confidence } : {}),
    };
  });
  const papers = [...paperHits.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([id, n]) => ({
      id,
      title: index.concepts.get(id)?.title ?? id,
      claims: n,
    }));
  return { query: trimmed, claims: rows, papers };
}

function rankedHubs(
  index: BundleIndex,
  incoming: Map<string, string[]>,
  type: string,
): Array<CompareRef & { papers: number }> {
  return (derivedOf(index).byType.get(type) ?? [])
    .map((record) => ({
      ...toRef(record),
      papers: paperDegree(index, incoming, record.id),
    }))
    .filter((item) => item.papers > 0)
    .sort((left, right) => right.papers - left.papers || left.title.localeCompare(right.title))
    .slice(0, STATS_TOP);
}

function paperDegree(
  index: BundleIndex,
  incoming: Map<string, string[]>,
  id: string,
): number {
  void incoming; // degree comes from the memoized paper-links table
  return derivedOf(index).paperLinks.get(id)?.size ?? 0;
}

export async function listCoverage(
  store: FileStore,
  scope: { topic?: string; from?: string; to?: string },
): Promise<unknown> {
  const index = await loadBundleIndex(store);
  const matrix = buildCoverageMatrix(index, scope);
  const gaps = listCoverageGaps(matrix);
  return {
    scope: matrix.scope,
    years: matrix.years,
    methods: matrix.methods,
    datasets: matrix.datasets,
    genes: matrix.genes,
    pathways: matrix.pathways,
    topics: matrix.topics.map((topic) => ({
      id: topic.id,
      title: topic.title,
      paperCount: topic.paperCount,
      missingYears: topic.missingYears,
      counts: matrix.years.map((year) => topic.years[year]?.count ?? 0),
      missingMethods: topic.missingMethods.map((method) => method.id),
      missingDatasets: topic.missingDatasets.map((dataset) => dataset.id),
      missingGenes: topic.missingGenes.map((gene) => gene.id),
      missingPathways: topic.missingPathways.map((pathway) => pathway.id),
    })),
    gaps: gaps.map((gap) => ({
      id: gap.id,
      kind: gap.kind,
      title: gap.title,
      topicId: gap.topicId,
      year: gap.year,
      hubId: gap.hubId,
      hubTitle: gap.hubTitle,
      paperId: gap.paperId,
    })),
  };
}

export async function saveNoteOp(
  store: FileStore,
  input: { title: string; body: string; paperIds?: string[]; claimIds?: string[] },
): Promise<{ path: string; id: string }> {
  const pathKey = await writeNote(store, input);
  invalidateBundleIndex();
  await refreshRootIndex(store);
  return { path: pathKey, id: toConceptId(pathKey) };
}

export async function citeCheckOp(
  store: FileStore,
  body: string,
): Promise<{ ok: boolean; cited: string[]; illegal: string[] }> {
  const index = await loadBundleIndex(store);
  return citeCheck(body, allowedCiteIds(index));
}

export async function saveSurveyOp(
  store: FileStore,
  input: { title: string; body: string; path?: string },
): Promise<{ path: string; cited: string[]; illegal: string[] }> {
  const title = input.title.trim();
  const body = input.body;
  if (!title) {
    throw new Error("okf_save_survey requires title");
  }
  if (typeof body !== "string") {
    throw new Error("okf_save_survey requires body");
  }
  const index = await loadBundleIndex(store);
  const allowed = allowedCiteIds(index);
  const check = citeCheck(body, allowed);
  if (!check.ok) {
    throw new Error(`illegal citations: ${check.illegal.join(", ")}`);
  }
  const papers = [...new Set(check.cited.filter((id) => id.startsWith("papers/")))];
  if (papers.length === 0) {
    throw new Error("survey body must cite at least one papers/ id from this folder");
  }
  const pathKey = input.path?.trim()
    ? surveyStorePath(input.path)
    : `surveys/${conceptSlug(title)}.md`;
  if (await store.exists(pathKey)) {
    const existing = parseDocument(utf8Decode(await store.read(pathKey)));
    if (isHumanVerified(existing.frontmatter)) {
      throw new Error(`${pathKey} is human-verified; edit the markdown instead of okf_save_survey`);
    }
  }
  const frontmatter: Frontmatter = {
    type: "Survey",
    title,
    status: "draft",
    cited: papers,
    generated: { by: "dsh-okf/save-survey", at: new Date().toISOString() },
  };
  await store.write(pathKey, serializeDocument(frontmatter, body));
  invalidateBundleIndex(store);
  await refreshRootIndex(store);
  return { path: pathKey, cited: papers, illegal: check.illegal };
}

export async function bibForSurvey(store: FileStore, surveyPath: string): Promise<{ path: string; bibtex: string }> {
  const pathKey = surveyStorePath(surveyPath);
  const bibtex = await bibtexForSurvey(store, pathKey);
  return { path: pathKey, bibtex };
}

export async function exportSurveyOp(
  store: FileStore,
  input: { survey: string; format: CiteStyle | "md" | "tex"; outDir: string },
): Promise<{ files: string[]; unresolved: string[] }> {
  const format: CiteStyle = input.format === "tex" || input.format === "latex" ? "latex" : "pandoc";
  const manuscript = await exportSurveyManuscript(store, surveyStorePath(input.survey));
  const outDir = path.resolve(input.outDir.trim());
  if (!outDir) {
    throw new Error("okf_export requires outDir");
  }
  await mkdir(outDir, { recursive: true });
  const ext = format === "latex" ? ".tex" : ".md";
  const body = format === "latex" ? manuscript.latex : manuscript.pandocMarkdown;
  const mainPath = path.join(outDir, `${manuscript.stem}${ext}`);
  const bibPath = path.join(outDir, `${manuscript.stem}.bib`);
  await writeFile(mainPath, body.endsWith("\n") ? body : `${body}\n`);
  await writeFile(bibPath, manuscript.bibtex.endsWith("\n") ? manuscript.bibtex : `${manuscript.bibtex}\n`);
  return { files: [mainPath, bibPath], unresolved: manuscript.unresolved };
}

export async function libraryGraphOp(
  store: FileStore,
  input: { query?: string; includeClaims?: boolean; id?: string; depth?: number } = {},
): Promise<{
  nodes: Array<{ id: string; type: string; title: string; published?: string }>;
  edges: Array<{ source: string; target: string }>;
  scope: "library" | "search" | "neighbors";
  truncated: boolean;
}> {
  const index = await loadBundleIndex(store);
  const query = input.query?.trim();
  const seedId = input.id?.trim();
  let allowed: Set<string> | undefined;
  let scope: "library" | "search" | "neighbors" = "library";
  if (seedId) {
    const pathKey = conceptPath(seedId);
    refuseOpaquePath(pathKey);
    const seed = index.concepts.get(toConceptId(pathKey));
    if (!seed) {
      throw new Error(`Concept not found: ${toConceptId(seedId)}`);
    }
    const depth = Math.max(1, Math.min(3, input.depth ?? 1));
    allowed = undirectedNeighborhood(index, [seed.id], depth);
    scope = "neighbors";
  } else if (query) {
    allowed = new Set<string>();
    const vectorHits = await queryVectorHits(index, embeddingClient(), query);
    for (const hit of retrieve(index, {
      text: query,
      ...(vectorHits ? { vectorHits } : {}),
    }).slice(0, SEARCH_HIT_LIMIT)) {
      if (isGraphNode(hit)) {
        allowed.add(hit.id);
      }
      for (const target of hit.outgoing.slice(0, OUTGOING_CAP)) {
        const record = index.concepts.get(target);
        if (record && isGraphNode(record)) {
          allowed.add(target);
        }
      }
    }
    scope = "search";
  }
  const includeClaims = Boolean(input.includeClaims) || Boolean(query) || scope === "neighbors";
  const rank: Record<string, number> = { Paper: 0, Topic: 1, Method: 2, Entity: 3, Dataset: 4, Gene: 5, Pathway: 6, Claim: 7 };
  const isAllowed = (record: ConceptRecord): boolean => !allowed || allowed.has(record.id);
  const eligibleOverview = [...index.concepts.values()]
    .filter((record) => isGraphNode(record) && record.type !== "Claim" && isAllowed(record))
    .sort((left, right) => (rank[left.type] ?? 8) - (rank[right.type] ?? 8) || left.id.localeCompare(right.id));
  const eligibleClaims = includeClaims
    ? [...index.concepts.values()].filter(
        (record) => isGraphNode(record) && record.type === "Claim" && isAllowed(record),
      )
    : [];
  // Claims are fairly distributed across their owning papers (each paper's best
  // by link count first) so one paper cannot monopolize the capped graph.
  const incoming = incomingOf(index);
  const degreeOfRecord = (record: ConceptRecord): number =>
    record.outgoing.length + (incoming.get(record.id)?.length ?? 0);
  const selected = [
    ...eligibleOverview,
    ...selectFairClaims(
      eligibleClaims,
      degreeOfRecord,
      Math.max(0, LIBRARY_GRAPH_NODE_CAP - eligibleOverview.length),
    ),
  ].slice(0, LIBRARY_GRAPH_NODE_CAP);
  const truncated = eligibleOverview.length + eligibleClaims.length > LIBRARY_GRAPH_NODE_CAP;
  const ids = new Set(selected.map((record) => record.id));
  const nodes = selected.map((record) => ({
    id: record.id,
    type: record.type,
    title: record.title ?? record.id,
    ...(record.published ? { published: record.published } : {}),
  }));
  const edges: Array<{ source: string; target: string }> = [];
  for (const record of selected) {
    for (const target of record.outgoing) {
      if (!ids.has(target) || record.id === target) {
        continue;
      }
      edges.push({ source: record.id, target });
      if (edges.length >= LIBRARY_GRAPH_EDGE_CAP) {
        break;
      }
    }
    if (edges.length >= LIBRARY_GRAPH_EDGE_CAP) {
      break;
    }
  }
  return {
    nodes,
    edges,
    scope,
    truncated,
  };
}

export async function packOkfOp(
  store: FileStore,
  okfDir: string,
  out: string,
  options: PackOptions = {},
): Promise<{ out: string; files: number; format: "zip" | "dir" }> {
  const dest = path.resolve(out.trim());
  if (!dest) {
    throw new Error("okf_pack requires out");
  }
  if (await sameResolvedPath(dest, okfDir)) {
    throw new Error("okf_pack refuses to write a pack onto the OKF folder itself; pick manuscripts/ or another path");
  }
  const format = dest.toLowerCase().endsWith(".zip") ? "zip" : "dir";
  await mkdir(format === "zip" ? path.dirname(dest) : dest, { recursive: true });
  if (format === "zip") {
    const bytes = await packToZip(store, options);
    await writeFile(dest, bytes);
    const files = await listPackPaths(store, options);
    return { out: dest, files: files.length, format };
  }
  const copied = await copyPack(store, new NodeFileStore(dest), options);
  return { out: dest, files: copied.length, format };
}

export async function mergeOkfOp(
  dstStore: FileStore,
  okfDir: string,
  fromDir: string,
): Promise<{
  from: string;
  added: string[];
  merged: string[];
  skipped: string[];
  conflicts: MergeReport["conflicts"];
  reportPath: string;
}> {
  const from = path.resolve(fromDir.trim());
  if (!from) {
    throw new Error("okf_merge requires from");
  }
  if (from.toLowerCase().endsWith(".zip")) {
    const zipInfo = await stat(from).catch(() => undefined);
    if (!zipInfo?.isFile()) {
      throw new Error(`okf_merge zip not found: ${from}`);
    }
    const src = await loadPackStoreFromZip(new Uint8Array(await readFile(from)));
    const report = await mergeBundles(src, dstStore);
    invalidateBundleIndex();
    await loadBundleIndex(dstStore);
    return {
      from,
      added: report.added,
      merged: report.merged,
      skipped: report.skipped,
      conflicts: report.conflicts,
      reportPath: ".okf/merge-report.md",
    };
  }
  if (await sameResolvedPath(from, okfDir)) {
    throw new Error("okf_merge refuses to merge a folder into itself");
  }
  const info = await stat(from).catch(() => undefined);
  if (!info?.isDirectory()) {
    throw new Error(`okf_merge source is not a folder or zip: ${from}`);
  }
  const report = await mergeBundles(new NodeFileStore(from), dstStore);
  invalidateBundleIndex();
  await loadBundleIndex(dstStore);
  return {
    from,
    added: report.added,
    merged: report.merged,
    skipped: report.skipped,
    conflicts: report.conflicts,
    reportPath: ".okf/merge-report.md",
  };
}

export async function compileSurveyOp(
  store: FileStore,
  client: ChatClient,
  model: string,
  input: { topic: string; from?: string; to?: string; out?: string; title?: string },
): Promise<unknown> {
  const topic = input.topic.trim();
  if (!topic) {
    throw new Error("okf_compile_survey requires topic");
  }
  const result = await compileSurvey(
    store,
    client,
    {
      topics: [topic],
      from: input.from?.trim() || undefined,
      to: input.to?.trim() || undefined,
      outPath: input.out?.trim() || undefined,
      title: input.title?.trim() || undefined,
    },
    { model },
  );
  invalidateBundleIndex(store);
  await refreshRootIndex(store);
  return result;
}

function refuseOpaquePath(pathKey: string): void {
  const key = pathKey.replace(/^\/+/, "");
  if (key.startsWith("sources/") || isOkfCachePath(key)) {
    throw new Error("okf_get does not serve PDFs or cache files; read Markdown concept pages instead.");
  }
}
