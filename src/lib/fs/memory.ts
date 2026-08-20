import {
  type FileStore,
  normalizeStorePath,
  utf8Encode,
} from "./types";

export class MemoryFileStore implements FileStore {
  private readonly files = new Map<string, Uint8Array>();
  private readonly mtimes = new Map<string, number>();
  private clock = 1;

  async read(path: string): Promise<Uint8Array> {
    const key = normalizeStorePath(path);
    const data = this.files.get(key);
    if (!data) {
      throw new Error(`File not found: ${key}`);
    }
    return data;
  }

  async write(path: string, data: Uint8Array | string): Promise<void> {
    const key = normalizeStorePath(path);
    this.files.set(key, typeof data === "string" ? utf8Encode(data) : data);
    this.clock += 1;
    this.mtimes.set(key, this.clock);
  }

  async rename(from: string, to: string): Promise<void> {
    const fromKey = normalizeStorePath(from);
    const toKey = normalizeStorePath(to);
    const data = this.files.get(fromKey);
    if (!data) {
      throw new Error(`File not found: ${fromKey}`);
    }
    this.files.delete(fromKey);
    this.files.set(toKey, data);
    const mtime = this.mtimes.get(fromKey);
    this.mtimes.delete(fromKey);
    if (mtime != null) {
      this.mtimes.set(toKey, mtime);
    }
  }

  async list(prefix: string): Promise<string[]> {
    const p = normalizeStorePath(prefix);
    return [...this.files.keys()]
      .filter((key) => (p === "" ? true : key === p || key.startsWith(`${p}/`)))
      .sort();
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(normalizeStorePath(path));
  }

  async remove(path: string): Promise<void> {
    const key = normalizeStorePath(path);
    this.files.delete(key);
    this.mtimes.delete(key);
  }

  async stat(path: string): Promise<{ size: number; mtimeMs?: number } | null> {
    const key = normalizeStorePath(path);
    const data = this.files.get(key);
    if (!data) {
      return null;
    }
    return { size: data.byteLength, mtimeMs: this.mtimes.get(key) };
  }
}
