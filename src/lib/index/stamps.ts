import type { Database } from "sql.js";
import type { FileStat, FileStore } from "@/lib/fs/types";
import { mapPool } from "@/lib/pipeline/pool";
import { sha256Hex } from "@/lib/pipeline/hash";
import { all } from "./sqlRows";

export type FileStamp = {
  size: number;
  mtimeMs?: number;
  hash?: string;
};

export function stampEquals(a: FileStamp, b: FileStamp): boolean {
  if (a.size !== b.size) {
    return false;
  }
  if (a.mtimeMs != null && b.mtimeMs != null) {
    return a.mtimeMs === b.mtimeMs;
  }
  return Boolean(a.hash) && a.hash === b.hash;
}

export async function stampPath(store: FileStore, path: string): Promise<FileStamp> {
  const info: FileStat | null = await store.stat(path);
  if (info?.mtimeMs != null) {
    return { size: info.size, mtimeMs: info.mtimeMs };
  }
  const data = await store.read(path);
  return { size: data.byteLength, hash: await sha256Hex(data) };
}

/** Bounded concurrency for bulk stat sweeps (10k+ files). */
export const STAMP_IO_CONCURRENCY = 16;

/** Stat many paths concurrently, preserving input order. Index syncs and the
 * workbench previously stat'ed every file sequentially, which is the dominant
 * IO cost on every startup / library open at 10k scale. */
export async function stampPaths(
  store: FileStore,
  paths: readonly string[],
): Promise<FileStamp[]> {
  return mapPool(paths, STAMP_IO_CONCURRENCY, (path) => stampPath(store, path));
}

/** Load per-path stamps from a `*_stamps` table. */
export function loadStamps(db: Database, table: string): Map<string, FileStamp> {
  const stmt = db.prepare(`SELECT path, size, mtime_ms, hash FROM ${table}`);
  const out = new Map<string, FileStamp>();
  for (const row of all(stmt)) {
    out.set(String(row.path), {
      size: Number(row.size),
      mtimeMs: row.mtime_ms == null ? undefined : Number(row.mtime_ms),
      hash: row.hash == null ? undefined : String(row.hash),
    });
  }
  return out;
}

/** Upsert a per-path stamp into a `*_stamps` table. */
export function upsertStamp(db: Database, table: string, path: string, stamp: FileStamp): void {
  db.run(
    `INSERT OR REPLACE INTO ${table}(path, size, mtime_ms, hash) VALUES (?, ?, ?, ?)`,
    [path, stamp.size, stamp.mtimeMs ?? null, stamp.hash ?? null],
  );
}
