import type { Database, SqlJsStatic } from "sql.js";
import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { okfCachePath } from "@/lib/okf/cache";
import { toConceptId } from "@/lib/okf/links";
import type { EmbeddingClient } from "@/lib/providers/types";
import { chunksForRecord, isEmbeddablePath } from "@/lib/retrieve/chunks";
import type { SearchHit } from "./search";
import { all, one } from "./sqlRows";
import { loadStamps, stampEquals, stampPaths, upsertStamp } from "./stamps";
import { listIndexableMarkdown, parseConceptRecord } from "./catalog";

export const VECTORS_PATH = okfCachePath("vectors.sqlite");
export const VECTORS_SCHEMA = "1";

export type VectorSearch = {
  model: string;
  chunkCount: number;
  search(queryEmbedding: number[], limit?: number): SearchHit[];
};

export type SyncVectorsResult = {
  chunks: number;
  changed: number;
  model: string;
};

function encodeEmbedding(values: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(values).buffer);
}

function decodeEmbedding(value: unknown): Float32Array | undefined {
  if (!value) {
    return undefined;
  }
  if (value instanceof Float32Array) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return new Float32Array(value.buffer, value.byteOffset, Math.floor(value.byteLength / 4));
  }
  if (Array.isArray(value)) {
    return Float32Array.from(value as number[]);
  }
  return undefined;
}

function initSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS vectors_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vectors_stamps (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mtime_ms INTEGER,
      hash TEXT
    );
    CREATE TABLE IF NOT EXISTS vectors_chunks (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS vectors_chunks_source ON vectors_chunks(source_id);
  `);
  db.run(`INSERT OR REPLACE INTO vectors_meta(key, value) VALUES ('schema', ?)`, [VECTORS_SCHEMA]);
}

function schemaOk(db: Database): boolean {
  try {
    const stmt = db.prepare(`SELECT value FROM vectors_meta WHERE key = 'schema'`);
    const row = one(stmt);
    return row?.value === VECTORS_SCHEMA;
  } catch {
    return false;
  }
}

function meta(db: Database, key: string): string | undefined {
  try {
    const stmt = db.prepare(`SELECT value FROM vectors_meta WHERE key = ?`);
    stmt.bind([key]);
    const row = one(stmt);
    return row ? String(row.value) : undefined;
  } catch {
    return undefined;
  }
}

function setMeta(db: Database, key: string, value: string): void {
  db.run(`INSERT OR REPLACE INTO vectors_meta(key, value) VALUES (?, ?)`, [key, value]);
}

function removeSource(db: Database, path: string): void {
  const id = toConceptId(path);
  db.run(`DELETE FROM vectors_chunks WHERE source_id = ?`, [id]);
  db.run(`DELETE FROM vectors_stamps WHERE path = ?`, [path]);
}

function wipeChunks(db: Database): void {
  db.run(`DELETE FROM vectors_chunks`);
  db.run(`DELETE FROM vectors_stamps`);
}

function chunkCount(db: Database): number {
  const stmt = db.prepare(`SELECT COUNT(*) AS n FROM vectors_chunks`);
  const row = one(stmt);
  return Number(row?.n ?? 0);
}

type VectorRow = {
  sourceId: string;
  values: Float32Array;
  norm: number;
};

export function createVectorSearch(db: Database): VectorSearch | undefined {
  const model = meta(db, "model");
  if (!model || !schemaOk(db)) {
    return undefined;
  }
  // Load every chunk embedding into memory once at search-construction time.
  // Per-query search then runs as a pure float32 scan with no repeated sql.js
  // BLOB decoding (10k files -> 100k+ chunks); norms are precomputed so cosine
  // similarity reduces to a dot product divided by two precomputed norms.
  const rows: VectorRow[] = [];
  {
    const stmt = db.prepare(`SELECT source_id, embedding FROM vectors_chunks`);
    for (const row of all(stmt)) {
      const sourceId = String(row.source_id ?? "");
      const embedding = decodeEmbedding(row.embedding);
      if (!sourceId || !embedding) {
        continue;
      }
      const values = Float32Array.from(embedding);
      let normSq = 0;
      for (let i = 0; i < values.length; i += 1) {
        normSq += values[i] * values[i];
      }
      rows.push({ sourceId, values, norm: Math.sqrt(normSq) });
    }
  }
  return {
    model,
    chunkCount: rows.length,
    search(queryEmbedding: number[], limit = 40): SearchHit[] {
      if (queryEmbedding.length === 0) {
        return [];
      }
      const query = Float32Array.from(queryEmbedding);
      let queryNormSq = 0;
      for (let i = 0; i < query.length; i += 1) {
        queryNormSq += query[i] * query[i];
      }
      const queryNorm = Math.sqrt(queryNormSq);
      if (queryNorm === 0) {
        return [];
      }
      const best = new Map<string, number>();
      for (const row of rows) {
        const n = Math.min(query.length, row.values.length);
        let dot = 0;
        for (let i = 0; i < n; i += 1) {
          dot += query[i] * row.values[i];
        }
        const denom = queryNorm * row.norm;
        const score = denom === 0 ? 0 : dot / denom;
        const prev = best.get(row.sourceId);
        if (prev == null || score > prev) {
          best.set(row.sourceId, score);
        }
      }
      return [...best.entries()]
        .map(([id, score]) => ({ id, score }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, limit);
    },
  };
}

async function openVectorsDb(
  store: FileStore,
  SQL: SqlJsStatic,
  persist: boolean,
): Promise<Database> {
  if (persist && (await store.exists(VECTORS_PATH))) {
    try {
      const bytes = await store.read(VECTORS_PATH);
      const db = new SQL.Database(new Uint8Array(bytes));
      if (schemaOk(db)) {
        return db;
      }
      db.close();
    } catch {
      // Rebuild.
    }
  }
  const db = new SQL.Database();
  initSchema(db);
  return db;
}

export async function loadVectorIndex(
  store: FileStore,
  SQL: SqlJsStatic,
): Promise<VectorSearch | undefined> {
  if (!(await store.exists(VECTORS_PATH))) {
    return undefined;
  }
  let db: Database | undefined;
  try {
    const bytes = await store.read(VECTORS_PATH);
    db = new SQL.Database(new Uint8Array(bytes));
    const search = createVectorSearch(db);
    // createVectorSearch copies every embedding row into JS memory, so the
    // sql.js database is no longer needed — release its WASM heap now.
    db.close();
    db = undefined;
    return search;
  } catch {
    if (db) {
      db.close();
    }
    return undefined;
  }
}

export async function syncVectors(
  store: FileStore,
  SQL: SqlJsStatic,
  embed: EmbeddingClient,
  options: { model: string; persist?: boolean },
): Promise<SyncVectorsResult> {
  const persist = options.persist !== false;
  const db = await openVectorsDb(store, SQL, persist);
  const storedModel = meta(db, "model");
  if (storedModel && storedModel !== options.model) {
    wipeChunks(db);
  }
  setMeta(db, "model", options.model);

  const paths = (await listIndexableMarkdown(store)).filter(isEmbeddablePath);
  const previous = loadStamps(db, "vectors_stamps");
  const seen = new Set<string>();
  let changed = 0;

  // Stat every file concurrently first; only changed files are read, chunked,
  // and embedded below (the embedding HTTP round-trips are the real cost).
  const stamps = await stampPaths(store, paths);
  for (let i = 0; i < paths.length; i += 1) {
    const path = paths[i]!;
    const stamp = stamps[i]!;
    seen.add(path);
    const old = previous.get(path);
    if (old && stampEquals(old, stamp) && storedModel === options.model) {
      continue;
    }
    const record = parseConceptRecord(path, utf8Decode(await store.read(path)));
    removeSource(db, path);
    if (!record) {
      upsertStamp(db, "vectors_stamps", path, stamp);
      changed += 1;
      continue;
    }
    const chunks = chunksForRecord(record);
    if (chunks.length > 0) {
      const vectors = await embed.embed(chunks.map((chunk) => chunk.text));
      if (vectors.length !== chunks.length) {
        throw new Error(`embed size ${vectors.length} != chunks ${chunks.length}`);
      }
      const dim = vectors[0]?.length ?? 0;
      if (dim > 0) {
        setMeta(db, "dim", String(dim));
      }
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const vector = vectors[i];
        if (!chunk || !vector) {
          continue;
        }
        db.run(
          `INSERT OR REPLACE INTO vectors_chunks(id, source_id, kind, ordinal, text, embedding)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [chunk.id, chunk.sourceId, chunk.kind, chunk.ordinal, chunk.text, encodeEmbedding(vector)],
        );
      }
    }
    upsertStamp(db, "vectors_stamps", path, stamp);
    changed += 1;
  }

  for (const path of previous.keys()) {
    if (!seen.has(path)) {
      removeSource(db, path);
      changed += 1;
    }
  }

  if (persist && (changed > 0 || !(await store.exists(VECTORS_PATH)))) {
    await store.write(VECTORS_PATH, db.export());
  }
  const chunks = chunkCount(db);
  // Release the sql.js WASM heap; export() already captured the bytes we need.
  db.close();

  return {
    chunks,
    changed,
    model: options.model,
  };
}
