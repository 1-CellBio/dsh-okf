import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { isSupportedSource, supportedFormats } from "@/lib/doc/anydocEngine";
import { resolveHostPath } from "@/paths";

const SKIP_DIR = new Set(["node_modules", ".git", ".okf", ".pnpm-store", "dist", "lib"]);

export type ExpandedSource = {
  filename: string;
  full: string;
};

/**
 * Expand okf_ingest paths: files stay files; directories recurse into supported
 * document types. Duplicate basenames keep the first hit and are reported.
 */
export async function expandSourcePaths(
  rawPaths: string[],
  pdfDir: string,
): Promise<{ files: ExpandedSource[]; warnings: string[] }> {
  const files: ExpandedSource[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawPaths) {
    const full = resolveHostPath(raw, pdfDir);
    await collect(full, files, warnings, seen);
  }
  return { files, warnings };
}

async function collect(
  full: string,
  files: ExpandedSource[],
  warnings: string[],
  seen: Set<string>,
): Promise<void> {
  let info;
  try {
    info = await stat(full);
  } catch {
    throw new Error(`okf_ingest: path not found ${JSON.stringify(full)}`);
  }
  if (info.isDirectory()) {
    const entries = await readdir(full, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const next = path.join(full, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR.has(entry.name)) {
          continue;
        }
        await collect(next, files, warnings, seen);
        continue;
      }
      if (entry.isFile() && isSupportedSource(entry.name)) {
        pushFile(next, entry.name, files, warnings, seen);
      }
    }
    return;
  }
  if (!info.isFile()) {
    throw new Error(`okf_ingest: not a file or directory ${JSON.stringify(full)}`);
  }
  const filename = path.basename(full);
  if (!isSupportedSource(filename)) {
    throw new Error(
      `okf_ingest: unsupported format ${JSON.stringify(filename)} (supported: ${supportedFormats()})`,
    );
  }
  pushFile(full, filename, files, warnings, seen);
}

function pushFile(
  full: string,
  filename: string,
  files: ExpandedSource[],
  warnings: string[],
  seen: Set<string>,
): void {
  const key = filename.toLowerCase();
  if (seen.has(key)) {
    warnings.push(`skip duplicate basename ${JSON.stringify(filename)} (${full})`);
    return;
  }
  seen.add(key);
  files.push({ filename, full });
}
