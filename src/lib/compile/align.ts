import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { asString, asTags } from "@/lib/okf/identity";
import { conceptPath, toConceptId } from "@/lib/okf/links";
import { parseDocument } from "@/lib/okf/parse";
import { conceptSlug } from "@/lib/okf/slug";
import { parentheticals } from "./hubMatch";
import { alignTokens, TOKEN_ALIGN_TYPES, tokenMatch } from "./tokens";

export const ALIGN_DIRS = ["topics", "methods", "entities", "datasets", "genes", "pathways"] as const;

export type AlignEntry = {
  path: string;
  id: string;
  type: string;
  title: string;
  aliases: string[];
};

export type AlignHit = AlignEntry & {
  matchedBy: "title" | "alias" | "slug" | "stem" | "token";
};

const STEM_MIN = 5;

/** Compact key: case, punctuation, and leading English articles dropped. */
export function normalizeAlignKey(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/^(the|an|a)\s+/u, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function stemKey(compact: string): string | undefined {
  if (compact.length > STEM_MIN && compact.endsWith("s") && !compact.endsWith("ss")) {
    return compact.slice(0, -1);
  }
  return undefined;
}

function slugFromPath(path: string): string {
  const base = path.replace(/^.*\//, "").replace(/\.md$/i, "");
  return base;
}

export class AlignIndex {
  private readonly byType = new Map<string, Map<string, { entry: AlignEntry; kind: AlignHit["matchedBy"] }[]>>();
  private readonly tokenSetsByPath = new Map<string, string[][]>();
  private readonly tokenIndex = new Map<string, Map<string, AlignEntry[]>>();

  add(entry: AlignEntry): void {
    const bucket = this.byType.get(entry.type) ?? new Map<string, { entry: AlignEntry; kind: AlignHit["matchedBy"] }[]>();
    this.byType.set(entry.type, bucket);
    const put = (key: string, kind: AlignHit["matchedBy"]): void => {
      if (!key) {
        return;
      }
      const list = bucket.get(key) ?? [];
      const rank: Record<AlignHit["matchedBy"], number> = {
        title: 0,
        alias: 1,
        slug: 2,
        stem: 3,
        token: 4,
      };
      const existing = list.find((item) => item.entry.path === entry.path);
      if (existing) {
        if (rank[kind] < rank[existing.kind]) {
          existing.kind = kind;
        }
        existing.entry = {
          ...existing.entry,
          aliases: [...new Set([...existing.entry.aliases, ...entry.aliases])],
        };
        return;
      }
      list.push({ entry, kind });
      bucket.set(key, list);
    };
    const titleKey = normalizeAlignKey(entry.title);
    put(`c:${titleKey}`, "title");
    put(`s:${conceptSlug(entry.title)}`, "slug");
    put(`s:${slugFromPath(entry.path)}`, "slug");
    const stemmed = stemKey(titleKey);
    if (stemmed) {
      put(`c:${stemmed}`, "stem");
    } else if (titleKey.length > STEM_MIN) {
      put(`c:${titleKey}s`, "stem");
    }
    for (const alias of [...entry.aliases, ...parentheticals(entry.title)]) {
      const aliasKey = normalizeAlignKey(alias);
      put(`c:${aliasKey}`, "alias");
      put(`s:${conceptSlug(alias)}`, "alias");
      const aliasStem = stemKey(aliasKey);
      if (aliasStem) {
        put(`c:${aliasStem}`, "stem");
      }
    }
    this.indexTokens(entry);
  }

  remove(path: string): void {
    this.tokenSetsByPath.delete(path);
    for (const bucket of this.byType.values()) {
      for (const [key, list] of [...bucket.entries()]) {
        const next = list.filter((item) => item.entry.path !== path);
        if (next.length === 0) {
          bucket.delete(key);
        } else {
          bucket.set(key, next);
        }
      }
    }
    for (const byToken of this.tokenIndex.values()) {
      for (const [token, list] of [...byToken.entries()]) {
        const next = list.filter((item) => item.path !== path);
        if (next.length === 0) {
          byToken.delete(token);
        } else {
          byToken.set(token, next);
        }
      }
    }
  }

  private indexTokens(entry: AlignEntry): void {
    if (!TOKEN_ALIGN_TYPES.has(entry.type)) {
      return;
    }
    const labels = [entry.title, ...entry.aliases, ...parentheticals(entry.title)];
    const sets: string[][] = [];
    const seenSet = new Set<string>();
    for (const label of labels) {
      const tokens = alignTokens(label);
      if (tokens.length === 0) {
        continue;
      }
      const key = tokens.join("\0");
      if (seenSet.has(key)) {
        continue;
      }
      seenSet.add(key);
      sets.push(tokens);
    }
    this.tokenSetsByPath.set(entry.path, sets);
    const byToken = this.tokenIndex.get(entry.type) ?? new Map<string, AlignEntry[]>();
    this.tokenIndex.set(entry.type, byToken);
    for (const tokens of sets) {
      for (const token of tokens) {
        const list = byToken.get(token) ?? [];
        if (!list.some((item) => item.path === entry.path)) {
          list.push(entry);
          byToken.set(token, list);
        }
      }
    }
  }

  lookup(type: string, title: string): AlignHit | undefined {
    const bucket = this.byType.get(type);
    if (!bucket) {
      return undefined;
    }
    const compact = normalizeAlignKey(title);
    const slug = conceptSlug(title);
    const stemmed = stemKey(compact);
    const probes: { key: string; prefer: AlignHit["matchedBy"][] }[] = [
      { key: `c:${compact}`, prefer: ["title", "alias", "stem"] },
      { key: `s:${slug}`, prefer: ["slug", "alias", "title"] },
    ];
    if (stemmed) {
      probes.push({ key: `c:${stemmed}`, prefer: ["title", "alias", "stem"] });
    } else if (compact.length > STEM_MIN) {
      probes.push({ key: `c:${compact}s`, prefer: ["title", "alias", "stem"] });
    }
    const rank: Record<AlignHit["matchedBy"], number> = {
      title: 0,
      alias: 1,
      slug: 2,
      stem: 3,
      token: 4,
    };
    for (const probe of probes) {
      const list = bucket.get(probe.key);
      if (!list || list.length === 0) {
        continue;
      }
      const allowed = new Set(probe.prefer);
      const hit = [...list]
        .filter((item) => allowed.has(item.kind))
        .sort((a, b) => rank[a.kind] - rank[b.kind])[0];
      if (hit) {
        return { ...hit.entry, matchedBy: hit.kind };
      }
    }
    return this.lookupToken(type, title);
  }

  private tokenHits(type: string, title: string): AlignEntry[] {
    if (!TOKEN_ALIGN_TYPES.has(type)) {
      return [];
    }
    const incoming = alignTokens(title);
    if (incoming.length === 0) {
      return [];
    }
    const byToken = this.tokenIndex.get(type);
    if (!byToken) {
      return [];
    }
    const seen = new Set<string>();
    const hits: AlignEntry[] = [];
    for (const token of incoming) {
      for (const entry of byToken.get(token) ?? []) {
        if (seen.has(entry.path)) {
          continue;
        }
        seen.add(entry.path);
        const sets = this.tokenSetsByPath.get(entry.path) ?? [alignTokens(entry.title)];
        if (sets.some((existing) => tokenMatch(existing, incoming) || tokenMatch(incoming, existing))) {
          hits.push(entry);
        }
      }
    }
    return hits;
  }

  private lookupToken(type: string, title: string): AlignHit | undefined {
    let best: { entry: AlignEntry; score: number } | undefined;
    const incoming = alignTokens(title);
    for (const entry of this.tokenHits(type, title)) {
      const sets = this.tokenSetsByPath.get(entry.path) ?? [alignTokens(entry.title)];
      const score = Math.max(...sets.map((tokens) => tokens.length), incoming.length);
      if (!best || score > best.score) {
        best = { entry, score };
      }
    }
    return best ? { ...best.entry, matchedBy: "token" } : undefined;
  }

  /** Every entry whose indexed keys collide with `title`'s lookup probes. */
  lookupAll(type: string, title: string): AlignEntry[] {
    const bucket = this.byType.get(type);
    if (!bucket) {
      return [];
    }
    const compact = normalizeAlignKey(title);
    const slug = conceptSlug(title);
    const stemmed = stemKey(compact);
    const probes: { key: string; prefer: AlignHit["matchedBy"][] }[] = [
      { key: `c:${compact}`, prefer: ["title", "alias", "stem"] },
      { key: `s:${slug}`, prefer: ["slug", "alias", "title"] },
    ];
    if (stemmed) {
      probes.push({ key: `c:${stemmed}`, prefer: ["title", "alias", "stem"] });
    } else if (compact.length > STEM_MIN) {
      probes.push({ key: `c:${compact}s`, prefer: ["title", "alias", "stem"] });
    }
    const seen = new Set<string>();
    const out: AlignEntry[] = [];
    for (const probe of probes) {
      const list = bucket.get(probe.key);
      if (!list || list.length === 0) {
        continue;
      }
      const allowed = new Set(probe.prefer);
      for (const item of list) {
        if (!allowed.has(item.kind) || seen.has(item.entry.path)) {
          continue;
        }
        seen.add(item.entry.path);
        out.push(item.entry);
      }
    }
    for (const hit of this.tokenHits(type, title)) {
      if (!seen.has(hit.path)) {
        seen.add(hit.path);
        out.push(hit);
      }
    }
    return out;
  }

  titlesByType(type: string, limit = 60): string[] {
    const bucket = this.byType.get(type);
    if (!bucket) {
      return [];
    }
    const seen = new Set<string>();
    const titles: string[] = [];
    for (const list of bucket.values()) {
      for (const item of list) {
        if (item.kind !== "title" || seen.has(item.entry.path)) {
          continue;
        }
        seen.add(item.entry.path);
        titles.push(item.entry.title);
        if (titles.length >= limit) {
          return titles;
        }
      }
    }
    return titles;
  }

  entriesByType(type: string, limit = 100): AlignEntry[] {
    const bucket = this.byType.get(type);
    if (!bucket) {
      return [];
    }
    const seen = new Set<string>();
    const out: AlignEntry[] = [];
    for (const list of bucket.values()) {
      for (const item of list) {
        if (item.kind !== "title" || seen.has(item.entry.path)) {
          continue;
        }
        seen.add(item.entry.path);
        out.push(item.entry);
        if (out.length >= limit) {
          return out;
        }
      }
    }
    return out;
  }
}

export function formatVocabularyForPrompt(index: AlignIndex): string {
  const blocks: string[] = [];
  for (const type of ["Topic", "Method", "Entity", "Dataset", "Gene", "Pathway"]) {
    const titles = index.titlesByType(type);
    if (titles.length === 0) {
      continue;
    }
    blocks.push(`${type}s: ${titles.join("; ")}`);
  }
  if (blocks.length === 0) {
    return "";
  }
  return [
    "Existing concepts in this bundle. Reuse these titles exactly when they match; do not invent near-synonym pages.",
    ...blocks,
  ].join("\n");
}

function asAliases(value: unknown): string[] {
  return asTags(value);
}

export async function loadAlignVocabulary(store: FileStore): Promise<AlignIndex> {
  const index = new AlignIndex();
  for (const dir of ALIGN_DIRS) {
    const paths = (await store.list(`${dir}/`)).filter((path) => path.endsWith(".md"));
    for (const path of paths) {
      const { frontmatter } = parseDocument(utf8Decode(await store.read(path)));
      const type = asString(frontmatter.type);
      if (!type) {
        continue;
      }
      const canonical = asString(frontmatter.canonical);
      if (canonical) {
        const canonPath = conceptPath(canonical);
        if (canonPath !== path && (await store.exists(canonPath))) {
          continue;
        }
      }
      if (asString(frontmatter.status) === "deprecated") {
        continue;
      }
      index.add({
        path,
        id: toConceptId(path),
        type,
        title: asString(frontmatter.title) ?? slugFromPath(path),
        aliases: asAliases(frontmatter.aliases),
      });
    }
  }
  return index;
}
