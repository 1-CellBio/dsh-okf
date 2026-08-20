import { isOkfCachePath } from "@/lib/okf/cache";
import { normalizeStorePath, type FileStore } from "@/lib/fs/types";

/**
 * FileStore wrapper that records every path a compile touches so its writes
 * can be undone atomically on failure. Rebuildable `.okf/` cache/state paths
 * are exempt from rollback: a failed compile's persisted LLM output survives
 * there so a retry can resume instead of restarting.
 */
export class TrackingStore implements FileStore {
  private readonly tracked = new Map<string, Uint8Array | null>();

  constructor(private readonly inner: FileStore) {}

  async read(path: string): Promise<Uint8Array> {
    return this.inner.read(path);
  }

  async write(path: string, data: Uint8Array | string): Promise<void> {
    const key = normalizeStorePath(path);
    if (!this.tracked.has(key)) {
      this.tracked.set(key, (await this.inner.exists(key)) ? await this.inner.read(key) : null);
    }
    await this.inner.write(key, data);
  }

  async rename(from: string, to: string): Promise<void> {
    const fromKey = normalizeStorePath(from);
    const toKey = normalizeStorePath(to);
    if (!this.tracked.has(fromKey)) {
      this.tracked.set(fromKey, (await this.inner.exists(fromKey)) ? await this.inner.read(fromKey) : null);
    }
    if (!this.tracked.has(toKey)) {
      this.tracked.set(toKey, (await this.inner.exists(toKey)) ? await this.inner.read(toKey) : null);
    }
    await this.inner.rename(from, to);
  }

  async list(prefix: string): Promise<string[]> {
    return this.inner.list(prefix);
  }

  async exists(path: string): Promise<boolean> {
    return this.inner.exists(path);
  }

  async remove(path: string): Promise<void> {
    const key = normalizeStorePath(path);
    if (!this.tracked.has(key)) {
      this.tracked.set(key, (await this.inner.exists(key)) ? await this.inner.read(key) : null);
    }
    await this.inner.remove(key);
  }

  async stat(path: string): Promise<{ size: number; mtimeMs?: number } | null> {
    return this.inner.stat(path);
  }

  /** Undo every knowledge write/remove this compile performed, in one pass. */
  async rollback(): Promise<void> {
    for (const [path, before] of this.tracked) {
      if (isOkfCachePath(path)) {
        continue;
      }
      if (before == null) {
        if (await this.inner.exists(path)) {
          await this.inner.remove(path);
        }
      } else {
        await this.inner.write(path, before);
      }
    }
  }
}
