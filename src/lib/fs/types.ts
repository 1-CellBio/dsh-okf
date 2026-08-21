export type FileStat = {
  size: number;
  mtimeMs?: number;
};

export interface FileStore {
  /** Identity of the store's root (e.g. the resolved directory path).
   * Used as a cache key for per-library indexes so that separate FileStore
   * instances pointing at the same root share the same index. */
  readonly root?: string;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array | string): Promise<void>;
  /** Optional capability: append without reading/rewriting the whole file.
   * Stores that cannot append (e.g. zips) leave it undefined; callers must
   * fall back to read-modify-write. */
  append?(path: string, data: Uint8Array | string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<FileStat | null>;
}

/** Bundle-relative path without a leading or trailing slash: `papers/foo.md`. */
export function normalizeStorePath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\\/g, "/").replace(/\/+$/g, "");
}

export function utf8Decode(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
