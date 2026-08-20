import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { LEGACY_OKF_CACHE_DIR, okfCachePath } from "@/lib/okf/cache";

export type PdfStatus =
  | "queued"
  | "extracting"
  | "extracting_vision"
  | "awaiting_vision"
  | "compiling"
  | "done"
  | "failed"
  | "needs_vision"
  | "compile_failed";

export type PdfExtractorKind = "text" | "vision" | "ocr" | "hybrid";
export type VisionStatus = "complete" | "pending" | "skipped";

export type PdfRecord = {
  sha256: string;
  extract?: string;
  paper?: string;
  extractor: PdfExtractorKind;
  status: PdfStatus;
  error?: string;
  visionPages?: number[];
  visionDone?: number[];
  visionStatus?: VisionStatus;
};

export type PipelineState = {
  pdfs: Record<string, PdfRecord>;
};

export const PIPELINE_STATE_PATH = okfCachePath("pipeline.json");
export const LEGACY_PIPELINE_STATE_PATH = `${LEGACY_OKF_CACHE_DIR}/pipeline.json`;

export function emptyState(): PipelineState {
  return { pdfs: {} };
}

export async function loadState(store: FileStore): Promise<PipelineState> {
  const path = (await store.exists(PIPELINE_STATE_PATH))
    ? PIPELINE_STATE_PATH
    : (await store.exists(LEGACY_PIPELINE_STATE_PATH))
      ? LEGACY_PIPELINE_STATE_PATH
      : undefined;
  if (!path) {
    return emptyState();
  }
  try {
    const raw = utf8Decode(await store.read(path));
    const parsed = JSON.parse(raw) as PipelineState;
    return parsed.pdfs ? parsed : emptyState();
  } catch {
    // Corrupt or truncated state file; start fresh instead of crashing the pipeline.
    return emptyState();
  }
}

let tmpCounter = 0;

export async function saveState(store: FileStore, state: PipelineState): Promise<void> {
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  // A unique temp name avoids colliding with a concurrent saveState that might
  // still be writing the same fixed .tmp file (two renames of one tmp → ENOENT).
  const tmp = `${PIPELINE_STATE_PATH}.${Date.now()}.${process.pid}.${(tmpCounter += 1)}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await store.write(tmp, serialized);
    await store.rename(tmp, PIPELINE_STATE_PATH);
  } catch (error) {
    await store.remove(tmp).catch(() => {});
    throw error;
  }
}

export function findByHash(state: PipelineState, sha256: string): PdfRecord | undefined {
  return Object.values(state.pdfs).find((record) => record.sha256 === sha256);
}
