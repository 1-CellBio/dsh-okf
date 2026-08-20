import type { PipelineState, PdfStatus } from "@/lib/pipeline/state";

export type PaperProcessKind = "ok" | "failed" | "running" | "imported";

export type PaperProcess = {
  kind: PaperProcessKind;
  status?: PdfStatus;
  error?: string;
};

const FAILED: PdfStatus[] = ["failed", "compile_failed", "needs_vision"];
const RUNNING: PdfStatus[] = [
  "queued",
  "extracting",
  "extracting_vision",
  "awaiting_vision",
  "compiling",
];

/** Map a compiled Paper onto the ingest/compile record for that PDF, if any. */
export function paperProcessStatus(paperId: string, state: PipelineState): PaperProcess {
  const record = Object.values(state.pdfs).find((item) => item.paper === paperId);
  if (!record) {
    return { kind: "imported" };
  }
  if (record.status === "done") {
    return { kind: "ok", status: record.status };
  }
  if (FAILED.includes(record.status)) {
    return { kind: "failed", status: record.status, ...(record.error ? { error: record.error } : {}) };
  }
  if (RUNNING.includes(record.status)) {
    return { kind: "running", status: record.status, ...(record.error ? { error: record.error } : {}) };
  }
  return { kind: "failed", status: record.status, ...(record.error ? { error: record.error } : {}) };
}
