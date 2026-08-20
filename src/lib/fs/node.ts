import { appendFile, mkdir, readdir, readFile, rename as fsRename, rm, stat as fsStat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type FileStore,
  normalizeStorePath,
  utf8Encode,
} from "./types";

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return undefined;
}

export class NodeFileStore implements FileStore {
  readonly root: string;
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    this.root = this.rootDir;
  }

  private resolve(rel: string): string {
    const full = path.resolve(this.rootDir, normalizeStorePath(rel));
    const relative = path.relative(this.rootDir, full);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path escapes store root: ${rel}`);
    }
    return full;
  }

  async read(pathRel: string): Promise<Uint8Array> {
    const key = normalizeStorePath(pathRel);
    try {
      const buf = await readFile(this.resolve(key));
      return new Uint8Array(buf);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new Error(`File not found: ${key}`, { cause: error });
      }
      throw error;
    }
  }

  async write(pathRel: string, data: Uint8Array | string): Promise<void> {
    const full = this.resolve(pathRel);
    await mkdir(path.dirname(full), { recursive: true });
    const bytes = typeof data === "string" ? utf8Encode(data) : data;
    await writeFile(full, bytes);
  }

  async append(pathRel: string, data: Uint8Array | string): Promise<void> {
    const full = this.resolve(pathRel);
    await mkdir(path.dirname(full), { recursive: true });
    const bytes = typeof data === "string" ? utf8Encode(data) : data;
    await appendFile(full, bytes);
  }

  async rename(from: string, to: string): Promise<void> {
    await fsRename(this.resolve(from), this.resolve(to));
  }

  async list(prefix: string): Promise<string[]> {
    const wanted = normalizeStorePath(prefix);
    const files: string[] = [];
    const walk = async (rel: string, full: string): Promise<void> => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(full, { withFileTypes: true });
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          return;
        }
        throw error;
      }
      for (const entry of entries) {
        const next = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(next, path.join(full, entry.name));
        } else if (entry.isFile()) {
          if (wanted === "" || next === wanted || next.startsWith(`${wanted}/`)) {
            files.push(next);
          }
        }
      }
    };
    await walk("", this.rootDir);
    return files.sort();
  }

  async exists(pathRel: string): Promise<boolean> {
    try {
      const info = await fsStat(this.resolve(pathRel));
      return info.isFile();
    } catch {
      return false;
    }
  }

  async remove(pathRel: string): Promise<void> {
    await rm(this.resolve(pathRel), { force: true });
  }

  async stat(pathRel: string): Promise<{ size: number; mtimeMs?: number } | null> {
    try {
      const info = await fsStat(this.resolve(pathRel));
      if (!info.isFile()) {
        return null;
      }
      return { size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  }
}
