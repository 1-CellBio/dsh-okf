import type { FileStore } from "./types";
import { normalizeStorePath, utf8Encode } from "./types";
import type { AnyDirectoryHandle, AnyFileHandle } from "./handles";

function splitPath(path: string): { dirs: string[]; file: string } {
  const parts = normalizeStorePath(path).split("/").filter(Boolean);
  const file = parts.pop();
  if (!file) {
    throw new Error(`Invalid file path: ${path}`);
  }
  return { dirs: parts, file };
}

async function walkDir(
  dir: AnyDirectoryHandle,
  prefix: string,
): Promise<AnyDirectoryHandle> {
  let current = dir;
  for (const part of prefix.split("/").filter(Boolean)) {
    current = await current.getDirectoryHandle(part, { create: true });
  }
  return current;
}

async function tryGetFile(
  root: AnyDirectoryHandle,
  path: string,
): Promise<AnyFileHandle | null> {
  try {
    const { dirs, file } = splitPath(path);
    let current = root;
    for (const part of dirs) {
      current = await current.getDirectoryHandle(part);
    }
    return await current.getFileHandle(file);
  } catch {
    return null;
  }
}

export class FileSystemAccessStore implements FileStore {
  constructor(private readonly handle: AnyDirectoryHandle) {}

  async read(path: string): Promise<Uint8Array> {
    const handle = await tryGetFile(this.handle, path);
    if (!handle) {
      throw new Error(`File not found: ${normalizeStorePath(path)}`);
    }
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async write(path: string, data: Uint8Array | string): Promise<void> {
    const { dirs, file } = splitPath(path);
    const dir = await walkDir(this.handle, dirs.join("/"));
    const handle = await dir.getFileHandle(file, { create: true });
    const writable = await handle.createWritable();
    const bytes = typeof data === "string" ? utf8Encode(data) : data;
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    await writable.write(copy);
    await writable.close();
  }

  async rename(from: string, to: string): Promise<void> {
    const source = await tryGetFile(this.handle, from);
    if (!source) {
      throw new Error(`File not found: ${normalizeStorePath(from)}`);
    }
    if (!source.move) {
      throw new Error("FileSystemAccessStore.rename requires FileSystemHandle.move()");
    }
    const { dirs, file } = splitPath(to);
    const dir = await walkDir(this.handle, dirs.join("/"));
    await source.move(dir, file);
  }

  async list(prefix: string): Promise<string[]> {
    const wanted = normalizeStorePath(prefix);
    const found: string[] = [];
    await this.walk("", this.handle, found);
    return found
      .filter((path) => (wanted === "" ? true : path === wanted || path.startsWith(`${wanted}/`)))
      .sort();
  }

  async exists(path: string): Promise<boolean> {
    return (await tryGetFile(this.handle, path)) !== null;
  }

  async stat(path: string): Promise<{ size: number; mtimeMs?: number } | null> {
    const handle = await tryGetFile(this.handle, path);
    if (!handle) {
      return null;
    }
    const file = await handle.getFile();
    const mtimeMs =
      "lastModified" in file && typeof file.lastModified === "number"
        ? file.lastModified
        : undefined;
    return { size: file.size, mtimeMs };
  }

  async remove(path: string): Promise<void> {
    const { dirs, file } = splitPath(path);
    let current = this.handle;
    for (const part of dirs) {
      current = await current.getDirectoryHandle(part);
    }
    await current.removeEntry(file);
  }

  private async walk(
    prefix: string,
    dir: AnyDirectoryHandle,
    out: string[],
  ): Promise<void> {
    for await (const entry of dir.values()) {
      const name = entry.name;
      if (!name) {
        continue;
      }
      const next = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === "directory") {
        await this.walk(next, entry as AnyDirectoryHandle, out);
      } else {
        out.push(next);
      }
    }
  }
}
