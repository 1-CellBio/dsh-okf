import { readBiblioFrontmatter } from "@/lib/biblio/apply";
import { AlignIndex, normalizeAlignKey, type AlignEntry } from "@/lib/compile/align";
import { catalogSymbolPair, levenshtein } from "@/lib/compile/hubMatch";
import { alignTokens, TOKEN_ALIGN_TYPES, tokenMatch, tokensEqual } from "@/lib/compile/tokens";
import { evidenceQuote } from "@/lib/compile/claims";
import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { listIndexableMarkdown, parseConceptRecord } from "@/lib/index/catalog";
import { okfCachePath } from "@/lib/okf/cache";
import { asTags, asString, paperConceptId, quoteInExtract } from "@/lib/okf/identity";
import { parseDocument } from "@/lib/okf/parse";
import { loadDismissedPairs, reviewPairKey } from "@/lib/review/dismiss";
import type { ConceptRecord } from "@/types/okf";

export const MERGE_REPORT_PATH = okfCachePath("merge-report.md");
export const REVIEW_QUEUE_PATH = okfCachePath("review-queue.json");

export const REVIEW_KINDS = [
  "missing_published",
  "missing_doi",
  "low_confidence_biblio",
  "disputed_claim",
  "extracted_claim",
  "near_duplicate",
  "merge_conflict",
  "draft",
] as const;

export type ReviewKind = (typeof REVIEW_KINDS)[number];

/** Exceptions a human should handle. Unquoted claims are pruned, not triaged. */
export const REVIEW_ACTION_KINDS = [
  "merge_conflict",
  "near_duplicate",
  "missing_published",
  "missing_doi",
  "low_confidence_biblio",
] as const satisfies readonly ReviewKind[];

/** Inventory leftovers. Extracted claims are the library, not a queue. */
export const REVIEW_BACKLOG_KINDS = [
  "disputed_claim",
  "draft",
] as const satisfies readonly ReviewKind[];

export type ReviewItem = {
  id: string;
  kind: ReviewKind;
  path: string;
  title: string;
  detail: string;
  otherPath?: string;
  otherTitle?: string;
  paper?: string;
  count?: number;
};

export const REVIEW_KIND_CAP = 40;

export type PackedReview = {
  total: number;
  actionTotal: number;
  backlogTotal: number;
  counts: Record<ReviewKind, number>;
  items: ReviewItem[];
  truncated: boolean;
};

export type BuildReviewQueueOptions = {
  persist?: boolean;
};

const ALIGN_TYPES = new Set(["Topic", "Method", "Entity", "Dataset", "Gene", "Pathway"]);
const NEAR_DUP_MIN_LEN = 6;
const NEAR_DUP_MAX_DIST = 2;
const KIND_RANK = Object.fromEntries(REVIEW_KINDS.map((kind, index) => [kind, index])) as Record<
  ReviewKind,
  number
>;

function paperLinkCount(record: ConceptRecord): number {
  return record.outgoing.filter((id) => id.startsWith("papers/")).length;
}

export { levenshtein };

/** All order-preserving subsequences of `key` after deleting up to `maxDelete`
 * characters. Two strings within Levenshtein distance `maxDelete` always share
 * one of these variants, so bucketing by variant yields a safe candidate set. */
export function deletionVariants(key: string, maxDelete: number): Set<string> {
  const out = new Set<string>([key]);
  if (maxDelete <= 0 || key.length <= 1) {
    return out;
  }
  for (let i = 0; i < key.length; i++) {
    out.add(key.slice(0, i) + key.slice(i + 1));
  }
  if (maxDelete >= 2) {
    for (let i = 0; i < key.length; i++) {
      for (let j = i + 1; j < key.length; j++) {
        out.add(key.slice(0, i) + key.slice(i + 1, j) + key.slice(j + 1));
      }
    }
  }
  return out;
}

function alignEntry(record: ConceptRecord, aliases: string[]): AlignEntry {
  return {
    path: record.path,
    id: record.id,
    type: record.type,
    title: record.title ?? record.id,
    aliases,
  };
}

function nearDuplicateReason(a: AlignEntry, b: AlignEntry): string | undefined {
  const index = new AlignIndex();
  index.add(a);
  const titleHit = index.lookup(b.type, b.title);
  if (titleHit && titleHit.path !== b.path) {
    return `align:${titleHit.matchedBy}`;
  }
  for (const alias of b.aliases) {
    const aliasHit = index.lookup(b.type, alias);
    if (aliasHit && aliasHit.path !== b.path) {
      return "align:alias";
    }
  }
  const ka = normalizeAlignKey(a.title);
  const kb = normalizeAlignKey(b.title);
  if (ka.length >= NEAR_DUP_MIN_LEN && kb.length >= NEAR_DUP_MIN_LEN) {
    const dist = levenshtein(ka, kb);
    if (dist > 0 && dist <= NEAR_DUP_MAX_DIST && !catalogSymbolPair(ka, kb)) {
      return `edit-distance:${dist}`;
    }
  }
  if (TOKEN_ALIGN_TYPES.has(a.type) && a.type === b.type) {
    const ta = alignTokens(a.title);
    const tb = alignTokens(b.title);
    if (tokensEqual(ta, tb)) {
      return "token:equal";
    }
    if (tokenMatch(ta, tb) || tokenMatch(tb, ta)) {
      return "token:contain";
    }
  }
  return undefined;
}

function preferredCanonical(a: ConceptRecord, b: ConceptRecord): { from: ConceptRecord; to: ConceptRecord } {
  const linksA = paperLinkCount(a);
  const linksB = paperLinkCount(b);
  if (linksA !== linksB) {
    return linksA > linksB ? { from: b, to: a } : { from: a, to: b };
  }
  if (a.path.length !== b.path.length) {
    return a.path.length < b.path.length ? { from: b, to: a } : { from: a, to: b };
  }
  return a.path < b.path ? { from: b, to: a } : { from: a, to: b };
}

export function parseMergeConflicts(raw: string): { path: string; reason: string }[] {
  const items: { path: string; reason: string }[] = [];
  let inConflicts = false;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      inConflicts = line.slice(3).trim() === "Conflicts";
      continue;
    }
    if (!inConflicts) {
      continue;
    }
    const match = line.match(/^- (.+)$/);
    if (!match) {
      continue;
    }
    const rest = match[1]?.trim() ?? "";
    if (!rest || rest === "(none)") {
      continue;
    }
    const colon = rest.indexOf(": ");
    if (colon === -1) {
      items.push({ path: rest, reason: "" });
    } else {
      items.push({ path: rest.slice(0, colon), reason: rest.slice(colon + 2) });
    }
  }
  return items;
}

async function extractBodiesByPaper(store: FileStore): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const paths = (await store.list("extracts/")).filter((path) => path.endsWith(".md"));
  for (const path of paths) {
    const doc = parseDocument(utf8Decode(await store.read(path)));
    const paper = asString(doc.frontmatter.paper);
    if (!paper) {
      continue;
    }
    const id = paperConceptId(paper);
    if (!out.has(id)) {
      out.set(id, doc.body);
    }
  }
  return out;
}

function sortItems(items: ReviewItem[]): ReviewItem[] {
  return [...items].sort((a, b) => {
    const kind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (kind !== 0) {
      return kind;
    }
    return a.path.localeCompare(b.path) || (a.otherPath ?? "").localeCompare(b.otherPath ?? "");
  });
}

export function formatReviewQueue(items: ReviewItem[]): string {
  if (items.length === 0) {
    return "Review queue (0)\n(none)\n";
  }
  const lines = [`Review queue (${items.length})`, ""];
  for (const kind of REVIEW_KINDS) {
    const group = items.filter((item) => item.kind === kind);
    if (group.length === 0) {
      continue;
    }
    lines.push(`${kind} (${group.length})`);
    for (const item of group) {
      const target = item.otherPath ? ` → ${item.otherPath}` : "";
      lines.push(`  ${item.path}${target}  ${item.title}`);
      if (item.detail) {
        lines.push(`    ${item.detail}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function isReviewAction(kind: ReviewKind): boolean {
  return (REVIEW_ACTION_KINDS as readonly ReviewKind[]).includes(kind);
}

/**
 * UI/agent snapshot: keep exception rows, fold unreviewed claims per paper,
 * and cap each kind so a 1000-paper library does not dump thousands of rows.
 */
export function packReviewQueue(items: ReviewItem[], cap = REVIEW_KIND_CAP): PackedReview {
  const counts = Object.fromEntries(REVIEW_KINDS.map((kind) => [kind, 0])) as Record<ReviewKind, number>;
  for (const item of items) {
    counts[item.kind] += 1;
  }
  const actionTotal = REVIEW_ACTION_KINDS.reduce((sum, kind) => sum + counts[kind], 0);
  const backlogTotal = REVIEW_BACKLOG_KINDS.reduce((sum, kind) => sum + counts[kind], 0);
  const folded = foldClaimsByPaper(items);
  const packed: ReviewItem[] = [];
  let truncated = false;
  const kindOrder = [...REVIEW_ACTION_KINDS, ...REVIEW_BACKLOG_KINDS];
  for (const kind of kindOrder) {
    const group = folded.filter((item) => item.kind === kind);
    if (group.length > cap) {
      truncated = true;
      packed.push(...group.slice(0, cap));
    } else {
      packed.push(...group);
    }
  }
  return {
    total: items.length,
    actionTotal,
    backlogTotal,
    counts,
    items: packed,
    truncated,
  };
}

function foldClaimsByPaper(items: ReviewItem[]): ReviewItem[] {
  const rest: ReviewItem[] = [];
  const groups = new Map<string, ReviewItem[]>();
  for (const item of items) {
    if ((item.kind !== "extracted_claim" && item.kind !== "disputed_claim") || !item.paper) {
      rest.push(item);
      continue;
    }
    const key = `${item.kind}|${item.paper}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  const folded: ReviewItem[] = [...groups.entries()].map(([, list]) => {
    const first = list[0]!;
    const n = list.length;
    const kind = first.kind;
    const paper = first.paper!;
    return {
      id: `${kind}:${paper}`,
      kind,
      path: paper.endsWith(".md") ? paper : `${paper}.md`,
      title: first.title,
      detail:
        n === 1
          ? (first.detail)
          : kind === "disputed_claim"
            ? `${n} unquoted claims`
            : `${n} unreviewed claims`,
      paper,
      count: n,
    };
  });
  return sortItems([...rest, ...folded]);
}

export async function buildReviewQueue(
  store: FileStore,
  options: BuildReviewQueueOptions = {},
): Promise<ReviewItem[]> {
  const persist = options.persist !== false;
  const paths = await listIndexableMarkdown(store);
  const records: ConceptRecord[] = [];
  const aliasesByPath = new Map<string, string[]>();
  const frontmatterByPath = new Map<string, ReturnType<typeof parseDocument>["frontmatter"]>();

  for (const path of paths) {
    const raw = utf8Decode(await store.read(path));
    const record = parseConceptRecord(path, raw);
    if (!record || record.type === "TextExtract") {
      continue;
    }
    const { frontmatter } = parseDocument(raw);
    frontmatterByPath.set(path, frontmatter);
    aliasesByPath.set(path, asTags(frontmatter.aliases));
    records.push(record);
  }

  const extracts = await extractBodiesByPaper(store);
  const items: ReviewItem[] = [];
  const claimQueued = new Set<string>();

  for (const record of records) {
    if (record.status === "deprecated") {
      continue;
    }
    if (record.type === "Paper") {
      if (!record.published) {
        items.push({
          id: `missing_published:${record.path}`,
          kind: "missing_published",
          path: record.path,
          title: record.title ?? record.id,
          detail: "Paper is missing published",
        });
      }
      if (!record.doi) {
        items.push({
          id: `missing_doi:${record.path}`,
          kind: "missing_doi",
          path: record.path,
          title: record.title ?? record.id,
          detail: "Paper is missing doi",
        });
      }
      const biblio = readBiblioFrontmatter(frontmatterByPath.get(record.path)?.biblio);
      if (biblio?.status === "suggested") {
        const hint = [
          biblio.source,
          biblio.suggested?.doi ? `doi=${biblio.suggested.doi}` : undefined,
          biblio.suggested?.title ? `title=${biblio.suggested.title}` : undefined,
          `score=${biblio.score}`,
        ]
          .filter(Boolean)
          .join(" ");
        items.push({
          id: `low_confidence_biblio:${record.path}`,
          kind: "low_confidence_biblio",
          path: record.path,
          title: record.title ?? record.id,
          detail: `Low-confidence biblio; title not applied. ${hint}`,
        });
      }
    }

    if (record.type === "Claim") {
      const quote = evidenceQuote(frontmatterByPath.get(record.path) ?? {});
      const extract = record.paper ? extracts.get(record.paper) : undefined;
      const quoteMismatch = Boolean(quote && extract && !quoteInExtract(quote, extract));
      const confidence = record.confidence ?? "extracted";
      if (confidence === "disputed" || quoteMismatch) {
        items.push({
          id: `disputed_claim:${record.path}`,
          kind: "disputed_claim",
          path: record.path,
          title: record.title ?? record.id,
          detail: quoteMismatch ? "quote not in extract" : "confidence: disputed",
          ...(record.paper ? { paper: record.paper } : {}),
        });
        claimQueued.add(record.path);
      }
      // confidence=extracted is the usable default. Do not enqueue thousands
      // of claims as if a human must stamp each one.
    }
  }

  const liveConcepts = records.filter(
    (record) => ALIGN_TYPES.has(record.type) && record.status !== "deprecated",
  );
  const seenPairs = new Set<string>();
  const dismissed = await loadDismissedPairs(store);

  const pushNearDuplicate = (a: ConceptRecord, b: ConceptRecord): void => {
    const pairKey = reviewPairKey(a.path, b.path);
    if (seenPairs.has(pairKey) || dismissed.has(pairKey)) {
      return;
    }
    const reason =
      nearDuplicateReason(
        alignEntry(a, aliasesByPath.get(a.path) ?? []),
        alignEntry(b, aliasesByPath.get(b.path) ?? []),
      ) ??
      nearDuplicateReason(
        alignEntry(b, aliasesByPath.get(b.path) ?? []),
        alignEntry(a, aliasesByPath.get(a.path) ?? []),
      );
    if (!reason) {
      return;
    }
    seenPairs.add(pairKey);
    const { from, to } = preferredCanonical(a, b);
    items.push({
      id: `near_duplicate:${from.path}|${to.path}`,
      kind: "near_duplicate",
      path: from.path,
      title: from.title ?? from.id,
      detail: `${from.title ?? from.id} ≈ ${to.title ?? to.id} (${reason})`,
      otherPath: to.path,
      otherTitle: to.title ?? to.id,
    });
  };

  // Candidate generation instead of an O(n²) scan: near-duplicates only arise
  // from (a) exact title/alias/slug/stem collisions, or (b) title edit distance
  // ≤ NEAR_DUP_MAX_DIST. Both are found by bucketing; each candidate is then
  // verified with the original nearDuplicateReason, so results are unchanged.
  if (liveConcepts.length > 0) {
    const byPath = new Map(liveConcepts.map((record) => [record.path, record] as const));
    const entries = liveConcepts.map((record) =>
      alignEntry(record, aliasesByPath.get(record.path) ?? []),
    );

    const index = new AlignIndex();
    for (const entry of entries) {
      index.add(entry);
    }
    for (const entry of entries) {
      const record = byPath.get(entry.path);
      if (!record) {
        continue;
      }
      for (const probe of [entry.title, ...entry.aliases]) {
        for (const hit of index.lookupAll(entry.type, probe)) {
          if (hit.path === entry.path) {
            continue;
          }
          const other = byPath.get(hit.path);
          if (other) {
            pushNearDuplicate(record, other);
          }
        }
      }
    }

    const buckets = new Map<string, ConceptRecord[]>();
    for (const entry of entries) {
      const record = byPath.get(entry.path);
      if (!record) {
        continue;
      }
      const key = normalizeAlignKey(entry.title);
      if (key.length < NEAR_DUP_MIN_LEN) {
        continue;
      }
      for (const variant of deletionVariants(key, NEAR_DUP_MAX_DIST)) {
        const bucketKey = `${entry.type}\u0000${variant}`;
        const list = buckets.get(bucketKey) ?? [];
        list.push(record);
        buckets.set(bucketKey, list);
      }
    }
    for (const bucket of buckets.values()) {
      for (let i = 0; i < bucket.length; i++) {
        const a = bucket[i];
        if (!a) {
          continue;
        }
        for (let j = i + 1; j < bucket.length; j++) {
          const b = bucket[j];
          if (!b) {
            continue;
          }
          pushNearDuplicate(a, b);
        }
      }
    }
  }

  if (await store.exists(MERGE_REPORT_PATH)) {
    const conflicts = parseMergeConflicts(utf8Decode(await store.read(MERGE_REPORT_PATH)));
    for (const conflict of conflicts) {
      items.push({
        id: `merge_conflict:${conflict.path}:${conflict.reason}`,
        kind: "merge_conflict",
        path: conflict.path,
        title: conflict.path,
        detail: conflict.reason,
      });
    }
  }

  for (const record of records) {
    if (record.status !== "draft") {
      continue;
    }
    if (claimQueued.has(record.path)) {
      continue;
    }
    items.push({
      id: `draft:${record.path}`,
      kind: "draft",
      path: record.path,
      title: record.title ?? record.id,
      detail: "status: draft",
    });
  }

  const sorted = sortItems(items);
  if (persist) {
    if (await store.exists(REVIEW_QUEUE_PATH)) {
      try {
        const prev = JSON.parse(utf8Decode(await store.read(REVIEW_QUEUE_PATH))) as { items?: unknown };
        if (JSON.stringify(prev.items) === JSON.stringify(sorted)) {
          return sorted;
        }
      } catch {
        // Rewrite if the cache is unreadable.
      }
    }
    await store.write(
      REVIEW_QUEUE_PATH,
      `${JSON.stringify({ generated: new Date().toISOString(), items: sorted }, null, 2)}\n`,
    );
  }
  return sorted;
}
