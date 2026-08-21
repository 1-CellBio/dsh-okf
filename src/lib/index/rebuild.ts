import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { GRAPH_NODE_TYPES } from "@/lib/okf/concepts";
import type { SqlJsStatic } from "sql.js";
import type { ConceptRecord } from "@/types/okf";
import {
  extractsByPaperMap,
  listIndexableMarkdown,
  parseConceptRecord,
  toCatalogRecord,
} from "./catalog";
import { createMiniSearchEngine } from "./miniSearchEngine";
import type { SearchEngine } from "./search";
import { syncSqliteIndex } from "./sqliteIndex";
import { loadVectorIndex, type VectorSearch } from "./vectors";

export type BundleIndex = {
  concepts: Map<string, ConceptRecord>;
  search: SearchEngine;
  extractsByPaper: Map<string, string>;
  vectors?: VectorSearch;
};

export type RebuildOptions = {
  /** When set, use SQLite FTS5 and persist `.okf/fts.sqlite`. */
  sql?: SqlJsStatic;
  persist?: boolean;
  onProgress?: (info: { done: number; total: number; changed: number }) => void;
};

export function isGraphNode(record: ConceptRecord): boolean {
  if (!(GRAPH_NODE_TYPES as readonly string[]).includes(record.type)) {
    return false;
  }
  if (record.status === "deprecated") {
    return false;
  }
  if (record.type === "Claim" && record.confidence === "disputed") {
    return false;
  }
  return true;
}

async function rebuildMiniIndex(store: FileStore): Promise<BundleIndex> {
  const paths = await listIndexableMarkdown(store);
  const concepts = new Map<string, ConceptRecord>();
  const searchDocs: { id: string; type: string; title: string; body: string }[] = [];

  for (const path of paths) {
    const record = parseConceptRecord(path, utf8Decode(await store.read(path)));
    if (!record) {
      continue;
    }
    searchDocs.push({
      id: record.id,
      type: record.type,
      title: record.title ?? record.id,
      body: record.body,
    });
    concepts.set(record.id, toCatalogRecord(record));
  }

  return {
    concepts,
    search: createMiniSearchEngine(searchDocs),
    extractsByPaper: extractsByPaperMap(concepts),
  };
}

export async function rebuildIndex(
  store: FileStore,
  options?: RebuildOptions,
): Promise<BundleIndex> {
  if (options?.sql) {
    const synced = await syncSqliteIndex(store, options.sql, {
      persist: options.persist,
      onProgress: options.onProgress,
    });
    const vectors = await loadVectorIndex(store, options.sql);
    return {
      concepts: synced.concepts,
      search: synced.search,
      extractsByPaper: synced.extractsByPaper,
      ...(vectors ? { vectors } : {}),
    };
  }
  return rebuildMiniIndex(store);
}