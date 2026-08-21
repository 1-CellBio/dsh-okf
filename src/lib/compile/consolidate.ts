import { rewriteBundleHref } from "@/lib/compile/mergeLinks";
import { AlignIndex, type AlignEntry } from "@/lib/compile/align";
import { autoMergeReason } from "@/lib/compile/hubMatch";
import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { listIndexableMarkdown, parseConceptRecord } from "@/lib/index/catalog";
import { asTags } from "@/lib/okf/identity";
import { canonicalizeConcept, type CanonicalizeResult } from "@/lib/okf/canonicalize";
import { parseDocument } from "@/lib/okf/parse";
import { isHumanVerified } from "@/lib/okf/validate";
import type { ConceptRecord } from "@/types/okf";

const HUB_TYPES = new Set(["Topic", "Method", "Entity", "Dataset", "Gene", "Pathway"]);

export type HubMerge = CanonicalizeResult & { reason: string };

function paperLinkCount(record: ConceptRecord): number {
  return record.outgoing.filter((id) => id.startsWith("papers/")).length;
}

function preferred(a: ConceptRecord, b: ConceptRecord): { from: ConceptRecord; to: ConceptRecord } {
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

function autoReason(a: AlignEntry, b: AlignEntry): string | undefined {
  return autoMergeReason(a, b);
}

async function loadLiveHubs(store: FileStore): Promise<{
  records: ConceptRecord[];
  aliases: Map<string, string[]>;
  verified: Set<string>;
}> {
  const records: ConceptRecord[] = [];
  const aliases = new Map<string, string[]>();
  const verified = new Set<string>();
  for (const path of await listIndexableMarkdown(store)) {
    const raw = utf8Decode(await store.read(path));
    const record = parseConceptRecord(path, raw);
    if (!record || !HUB_TYPES.has(record.type)) {
      continue;
    }
    if (record.status === "deprecated") {
      continue;
    }
    const { frontmatter } = parseDocument(raw);
    if (isHumanVerified(frontmatter)) {
      verified.add(path);
    }
    aliases.set(path, asTags(frontmatter.aliases));
    records.push(record);
  }
  return { records, aliases, verified };
}

function entryOf(record: ConceptRecord, aliases: Map<string, string[]>): AlignEntry {
  return {
    path: record.path,
    id: record.id,
    type: record.type,
    title: record.title ?? record.id,
    aliases: aliases.get(record.path) ?? [],
  };
}

/**
 * Merge high-confidence duplicate hubs (equal tokens after filler-word drop,
 * or title edit distance ≤ 2). Human-verified pages are never the source of
 * a silent merge. When `onlyPaths` is set, at least one side must be in that
 * set so a per-paper compile does not rewrite the whole library.
 */
export async function consolidateHubs(
  store: FileStore,
  vocab: AlignIndex | undefined,
  options: {
    onlyPaths?: Iterable<string>;
    onLog?: (line: string) => void;
  } = {},
): Promise<HubMerge[]> {
  const { records, aliases, verified } = await loadLiveHubs(store);
  if (records.length < 2) {
    return [];
  }
  const only = options.onlyPaths ? new Set([...options.onlyPaths]) : undefined;
  const byPath = new Map(records.map((record) => [record.path, record] as const));
  const seen = new Set<string>();
  const pairs: Array<{ from: ConceptRecord; to: ConceptRecord; reason: string }> = [];

  const consider = (left: ConceptRecord, right: ConceptRecord): void => {
    if (left.path === right.path || left.type !== right.type) {
      return;
    }
    if (only && !only.has(left.path) && !only.has(right.path)) {
      return;
    }
    const key = [left.path, right.path].sort().join("|");
    if (seen.has(key)) {
      return;
    }
    const reason = autoReason(entryOf(left, aliases), entryOf(right, aliases));
    if (!reason) {
      return;
    }
    seen.add(key);
    let { from, to } = preferred(left, right);
    if (verified.has(from.path) && !verified.has(to.path)) {
      const swap = from;
      from = to;
      to = swap;
    }
    if (verified.has(from.path)) {
      return;
    }
    pairs.push({ from, to, reason });
  };

  const index = new AlignIndex();
  for (const record of records) {
    index.add(entryOf(record, aliases));
  }
  for (const record of records) {
    const self = entryOf(record, aliases);
    for (const probe of [self.title, ...self.aliases]) {
      for (const hit of index.lookupAll(record.type, probe)) {
        const other = byPath.get(hit.path);
        if (other) {
          consider(record, other);
        }
      }
    }
  }

  const merged: HubMerge[] = [];
  const gone = new Set<string>();
  for (const pair of pairs) {
    if (gone.has(pair.from.path) || gone.has(pair.to.path)) {
      continue;
    }
    if (!(await store.exists(pair.from.path)) || !(await store.exists(pair.to.path))) {
      continue;
    }
    const result = await canonicalizeConcept(store, pair.from.path, pair.to.path);
    gone.add(pair.from.path);
    vocab?.remove(pair.from.path);
    const toRecord = byPath.get(pair.to.path);
    if (toRecord) {
      vocab?.add({
        path: pair.to.path,
        id: toRecord.id,
        type: toRecord.type,
        title: toRecord.title ?? toRecord.id,
        aliases: [...new Set([...(aliases.get(pair.to.path) ?? []), pair.from.title ?? pair.from.id])],
      });
    }
    options.onLog?.(`consolidate ${result.from} → ${result.to} (${pair.reason})`);
    merged.push({ ...result, reason: pair.reason });
  }
  return merged;
}

export function applyHubMergesToBody(body: string, merges: HubMerge[]): string {
  let next = body;
  for (const merge of merges) {
    next = rewriteBundleHref(next, merge.from, merge.to);
  }
  return next;
}
