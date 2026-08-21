import { AlignIndex, normalizeAlignKey, type AlignEntry } from "@/lib/compile/align";
import { catalogSymbolPair, looksLikeVersionPair } from "@/lib/compile/hubMatch";
import { canonicalizeConcept } from "@/lib/okf/canonicalize";
import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { listIndexableMarkdown, parseConceptRecord } from "@/lib/index/catalog";
import { asTags } from "@/lib/okf/identity";
import { parseDocument } from "@/lib/okf/parse";
import { isHumanVerified } from "@/lib/okf/validate";
import type { ChatClient } from "@/lib/providers/types";
import type { ConceptRecord } from "@/types/okf";
import type { HubMerge } from "./consolidate";

/** Genes stay lexical-only. Catalog symbols and versions are hard-blocked below. */
export const ALIAS_LLM_TYPES = new Set(["Topic", "Method", "Entity", "Dataset", "Pathway"]);

const EXISTING_CAP = 100;
const LIBRARY_CAP = 150;
const INCOMING_CAP = 24;

const INCOMING_SYSTEM = `You map NEW scientific concept titles onto EXISTING OKF hub pages of the same type.
Return JSON only: {"reuse":[{"title":"<new title exactly>","path":"<existing path>"}]}
Rules:
- Include a row only when the new title is the same concept as that existing page (synonym, translation, abbreviation, or longer/shorter name).
- Distinct genes, datasets, methods, papers, subtypes, or versioned tools (Cellpose vs Cellpose3) → omit.
- When unsure, omit. Empty reuse is fine.
- Never invent a path. path must be copied from EXISTING.`;

const LIBRARY_SYSTEM = `You find duplicate OKF hub pages that are the same scientific concept under different names.
Return JSON only: {"same":[["<path a>","<path b>"]]}
Rules:
- Same type only. Synonym / translation / abbreviation / longer name of the same concept → pair them.
- Distinct genes, datasets, methods, versions, or related-but-different topics → omit.
- When unsure, omit. Empty same is fine.
- Copy paths exactly from the list. At most one pair per path.`;

export type IncomingHub = { type: string; title: string };

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

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = (fenced?.[1] ?? raw).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

export function parseReuseRows(raw: string): Array<{ title: string; path: string }> {
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const reuse = (parsed as { reuse?: unknown }).reuse;
  if (!Array.isArray(reuse)) {
    return [];
  }
  const out: Array<{ title: string; path: string }> = [];
  for (const row of reuse) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const title = typeof (row as { title?: unknown }).title === "string"
      ? (row as { title: string }).title.trim()
      : "";
    const path = typeof (row as { path?: unknown }).path === "string"
      ? (row as { path: string }).path.trim().replace(/^\/+/, "")
      : "";
    if (title && path) {
      out.push({ title, path });
    }
  }
  return out;
}

export function parseSamePairs(raw: string): Array<[string, string]> {
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const same = (parsed as { same?: unknown }).same;
  if (!Array.isArray(same)) {
    return [];
  }
  const out: Array<[string, string]> = [];
  for (const row of same) {
    if (!Array.isArray(row) || row.length < 2) {
      continue;
    }
    const a = typeof row[0] === "string" ? row[0].trim().replace(/^\/+/, "") : "";
    const b = typeof row[1] === "string" ? row[1].trim().replace(/^\/+/, "") : "";
    if (a && b && a !== b) {
      out.push([a, b]);
    }
  }
  return out;
}

function blockedPair(a: string, b: string): boolean {
  return looksLikeVersionPair(a, b) || catalogSymbolPair(a, b);
}

function formatExisting(entries: AlignEntry[]): string {
  return entries
    .map((entry) => {
      const aliases = entry.aliases.length > 0 ? ` | aliases: ${entry.aliases.slice(0, 4).join("; ")}` : "";
      return `- ${entry.type} | ${entry.path} | ${entry.title}${aliases}`;
    })
    .join("\n");
}

/**
 * For new titles that missed lexical align, ask the compile LLM whether an
 * existing hub of the same type is the same concept. Conservative: no row or
 * a failed call means keep the new page.
 */
export async function aliasAlignIncoming(
  client: ChatClient,
  vocab: AlignIndex,
  incoming: IncomingHub[],
  options: { onLog?: (line: string) => void } = {},
): Promise<Map<string, AlignEntry>> {
  const hits = new Map<string, AlignEntry>();
  const pending: IncomingHub[] = [];
  const existingByType = new Map<string, AlignEntry[]>();
  for (const item of incoming) {
    if (!ALIAS_LLM_TYPES.has(item.type) || !item.title.trim()) {
      continue;
    }
    if (vocab.lookup(item.type, item.title)) {
      continue;
    }
    const existing = existingByType.get(item.type) ?? vocab.entriesByType(item.type, EXISTING_CAP);
    existingByType.set(item.type, existing);
    if (existing.length === 0) {
      continue;
    }
    pending.push(item);
    if (pending.length >= INCOMING_CAP) {
      break;
    }
  }
  if (pending.length === 0) {
    return hits;
  }
  const existingLines = [...existingByType.entries()]
    .filter(([, list]) => list.length > 0)
    .map(([type, list]) => `${type}:\n${formatExisting(list)}`)
    .join("\n");
  const newLines = pending.map((item) => `- ${item.type} | ${item.title}`).join("\n");
  try {
    const raw = await client.complete([
      { role: "system", content: INCOMING_SYSTEM },
      {
        role: "user",
        content: ["NEW", newLines, "", "EXISTING", existingLines].join("\n"),
      },
    ]);
    const byTitle = new Map(pending.map((item) => [normalizeAlignKey(item.title), item] as const));
    const byPath = new Map<string, AlignEntry>();
    for (const list of existingByType.values()) {
      for (const entry of list) {
        byPath.set(entry.path, entry);
      }
    }
    for (const row of parseReuseRows(raw)) {
      const item = byTitle.get(normalizeAlignKey(row.title));
      const target = byPath.get(row.path);
      if (!item || !target || target.type !== item.type) {
        continue;
      }
      if (blockedPair(item.title, target.title)) {
        continue;
      }
      hits.set(normalizeAlignKey(item.title), target);
      options.onLog?.(`alias reuse "${item.title}" → ${target.path}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onLog?.(`alias pass skipped: ${message}`);
  }
  return hits;
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
    if (!record || !ALIAS_LLM_TYPES.has(record.type) || record.status === "deprecated") {
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

/**
 * After a batch, ask the LLM once per type for remaining synonym pairs
 * lexical consolidate missed. Caps the title list; over-cap types are skipped.
 */
export async function aliasConsolidateHubs(
  store: FileStore,
  client: ChatClient,
  vocab: AlignIndex | undefined,
  options: { onLog?: (line: string) => void } = {},
): Promise<HubMerge[]> {
  const { records, aliases, verified } = await loadLiveHubs(store);
  const byType = new Map<string, ConceptRecord[]>();
  for (const record of records) {
    const list = byType.get(record.type) ?? [];
    list.push(record);
    byType.set(record.type, list);
  }
  const merged: HubMerge[] = [];
  const gone = new Set<string>();
  for (const [type, group] of byType) {
    if (group.length < 2) {
      continue;
    }
    if (group.length > LIBRARY_CAP) {
      options.onLog?.(`alias consolidate skipped ${type} n=${group.length} (cap ${LIBRARY_CAP})`);
      continue;
    }
    const byPath = new Map(group.map((record) => [record.path, record] as const));
    const listing = group
      .map((record) => {
        const extra = aliases.get(record.path) ?? [];
        const aliasBit = extra.length > 0 ? ` | ${extra.slice(0, 3).join("; ")}` : "";
        return `- ${record.path} | ${record.title ?? record.id}${aliasBit}`;
      })
      .join("\n");
    let pairs: Array<[string, string]> = [];
    try {
      const raw = await client.complete([
        { role: "system", content: LIBRARY_SYSTEM },
        { role: "user", content: `${type} hubs:\n${listing}` },
      ]);
      pairs = parseSamePairs(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onLog?.(`alias consolidate skipped ${type}: ${message}`);
      continue;
    }
    for (const [leftPath, rightPath] of pairs) {
      const left = byPath.get(leftPath);
      const right = byPath.get(rightPath);
      if (!left || !right || left.path === right.path) {
        continue;
      }
      if (blockedPair(left.title ?? left.id, right.title ?? right.id)) {
        continue;
      }
      if (gone.has(left.path) || gone.has(right.path)) {
        continue;
      }
      let { from, to } = preferred(left, right);
      if (verified.has(from.path) && !verified.has(to.path)) {
        const swap = from;
        from = to;
        to = swap;
      }
      if (verified.has(from.path)) {
        continue;
      }
      if (!(await store.exists(from.path)) || !(await store.exists(to.path))) {
        continue;
      }
      const result = await canonicalizeConcept(store, from.path, to.path);
      gone.add(from.path);
      vocab?.remove(from.path);
      vocab?.add({
        path: to.path,
        id: to.id,
        type: to.type,
        title: to.title ?? to.id,
        aliases: [...new Set([...(aliases.get(to.path) ?? []), from.title ?? from.id])],
      });
      options.onLog?.(`alias consolidate ${result.from} → ${result.to}`);
      merged.push({ ...result, reason: "alias:llm" });
    }
  }
  return merged;
}
