import { MemoryFileStore } from "@/lib/fs/memory";
import type { FileStore } from "@/lib/fs/types";
import { normalizeStorePath } from "@/lib/fs/types";
import { isOkfCachePath } from "@/lib/okf/cache";
import { unzipFiles, zipFiles } from "./zip";

export const PACK_PREFIXES = [
  "papers/",
  "topics/",
  "methods/",
  "entities/",
  "datasets/",
  "genes/",
  "pathways/",
  "claims/",
  "notes/",
  "questions/",
  "surveys/",
  "extracts/",
] as const;

export const PACK_ROOT_FILES = ["index.md", "AGENTS.md"] as const;

export type PackOptions = {
  omitNotes?: boolean;
  omitExtracts?: boolean;
};

export function isPackPath(path: string, options: PackOptions = {}): boolean {
  const normalized = normalizeStorePath(path);
  if (
    normalized.startsWith("sources/") ||
    isOkfCachePath(normalized) ||
    normalized === "log.md" ||
    normalized.startsWith("log.md/")
  ) {
    return false;
  }
  if (options.omitNotes && normalized.startsWith("notes/")) {
    return false;
  }
  if (options.omitExtracts && normalized.startsWith("extracts/")) {
    return false;
  }
  if ((PACK_ROOT_FILES as readonly string[]).includes(normalized)) {
    return true;
  }
  return PACK_PREFIXES.some((prefix) => normalized.startsWith(prefix) && normalized.endsWith(".md"));
}

export async function listPackPaths(store: FileStore, options: PackOptions = {}): Promise<string[]> {
  return (await store.list("")).filter((path) => isPackPath(path, options)).sort();
}

export async function copyPack(
  src: FileStore,
  dst: FileStore,
  options: PackOptions = {},
): Promise<string[]> {
  const paths = await listPackPaths(src, options);
  for (const path of paths) {
    await dst.write(path, await src.read(path));
  }
  return paths;
}

export async function packToZip(store: FileStore, options: PackOptions = {}): Promise<Uint8Array> {
  const paths = await listPackPaths(store, options);
  const files = [];
  for (const path of paths) {
    files.push({ path, data: await store.read(path) });
  }
  return zipFiles(files);
}

function ignoreZipName(name: string): boolean {
  const normalized = normalizeStorePath(name);
  if (normalized.startsWith("__MACOSX/") || normalized === "__MACOSX") {
    return true;
  }
  const base = normalized.split("/").pop() ?? normalized;
  return base === ".DS_Store" || base.startsWith("._");
}

/** Strip a single wrapper folder (`knowledge-bundle/papers/…`) if pack files are not at the zip root. */
export function packPathPrefix(names: string[]): string {
  const files = names
    .map((name) => normalizeStorePath(name))
    .filter((name) => name && !name.endsWith("/") && !ignoreZipName(name));
  if (files.some((name) => isPackPath(name))) {
    return "";
  }
  const tops = new Set(files.map((name) => name.split("/")[0]).filter((part): part is string => Boolean(part)));
  if (tops.size !== 1) {
    return "";
  }
  const wrap = [...tops][0];
  if (!wrap || wrap.startsWith(".")) {
    return "";
  }
  const prefix = `${wrap}/`;
  if (files.some((name) => name.startsWith(prefix) && isPackPath(name.slice(prefix.length)))) {
    return prefix;
  }
  return "";
}

/** Load an exported OKF zip into a memory store. Accepts a wrapper folder Finder adds when unzipping/rezipping. */
export async function loadPackStoreFromZip(bytes: Uint8Array): Promise<MemoryFileStore> {
  const entries = await unzipFiles(bytes);
  const prefix = packPathPrefix(entries.map((entry) => entry.path));
  const store = new MemoryFileStore();
  let count = 0;
  for (const entry of entries) {
    if (ignoreZipName(entry.path)) {
      continue;
    }
    const rel = prefix && entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path;
    if (!isPackPath(rel)) {
      continue;
    }
    await store.write(rel, entry.data);
    count += 1;
  }
  if (count === 0) {
    throw new Error(
      "This zip is not an OKF pack. Export knowledge-bundle.zip from the workbench (papers/, topics/, … inside), or unpack it and merge that folder.",
    );
  }
  return store;
}
