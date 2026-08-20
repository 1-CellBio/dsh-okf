import type { BiblioClient } from "@/lib/biblio/types";
import type { AlignIndex } from "@/lib/compile/align";
import { loadAlignVocabulary } from "@/lib/compile/align";
import { compileExtract } from "@/lib/compile/run";
import { joinVisualMarkdown, visionIsComplete, visualSectionOf } from "@/lib/extractors/mergeVisual";
import { planVisualPages } from "@/lib/extractors/pagePlan";
import { writeExtract, type WriteExtractExtras } from "@/lib/extractors/text";
import type { Extractor, ExtractResult, RasterOptions } from "@/lib/extractors/types";
import { runVisionExtract, VISION_MAX_EDGE } from "@/lib/extractors/vision";
import { VISION_PAUSE_DEFAULT } from "@/lib/extractors/visionGate";
import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { withPathLock } from "@/lib/fs/pathLock";
import { TrackingStore } from "@/lib/fs/trackingStore";
import { parseDocument } from "@/lib/okf/parse";
import type { ChatClient } from "@/lib/providers/types";
import { bootstrapBundle } from "./bootstrap";
import { sha256Hex } from "./hash";
import { appendLog, refreshRootIndex } from "./log";
import { findByHash, loadState, saveState, type PdfRecord, type PipelineState } from "./state";

export type PdfInput = {
  filename: string;
  bytes: Uint8Array;
};

/** Vision page policy for okf_ingest. */
export type VisionMode =
  | "auto" // within maxPages budget run full vision; above it, pause (awaiting_vision)
  | "all" // run full vision regardless of page count
  | "figures" // vision on figure-bearing pages only (drop thin-text pages)
  | "skip" // skip optional vision on born-digital PDFs (scans still need vision)
  | { pages: number[] }; // explicit page subset (within the planned pages)

export type PipelineDeps = {
  extractor: Extractor;
  client: ChatClient;
  model: string;
  now?: string;
  raster?: (pdf: Uint8Array, page: number, opts?: RasterOptions) => Promise<Uint8Array>;
  /** Vision page policy. Default { mode: "auto", maxPages: VISION_PAUSE_DEFAULT }. */
  vision?: {
    mode: VisionMode;
    /** Pause budget for mode "auto". Default VISION_PAUSE_DEFAULT (12). */
    maxPages?: number;
  };
  /** When false, stop after extract (and optional vision). Default true. */
  compile?: boolean;
  biblio?: BiblioClient;
  /** Extra progress lines (job_output). Store log.md is always written. */
  onLog?: (line: string) => void;
  /** Override vision retry backoff (tests use 0). */
  visionRetryDelayMs?: number;
};

export type PdfRunResult = {
  path: string;
  status: string;
  skipped?: boolean;
};

function pdfStorePath(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  // PDFs live under sources/pdfs/ (library convention); other document
  // formats (docx/pptx/xlsx/…) under sources/docs/.
  const isPdf = /\.pdf$/i.test(base);
  return isPdf ? `sources/pdfs/${base}` : `sources/docs/${base}`;
}

/** Serializes all pipeline runs against the same library (state is a single
 * JSON file mutated in memory, so concurrent runs would overwrite each other). */
function pipelineLockKey(store: FileStore): string {
  return `${store.root ?? "library"}:pipeline`;
}

export async function runPipeline(
  store: FileStore,
  inputs: PdfInput[],
  deps: PipelineDeps,
): Promise<PdfRunResult[]> {
  return withPathLock(pipelineLockKey(store), async () => {
    await bootstrapBundle(store);
    const state = await loadState(store);
    // Load the alignment vocabulary once per run instead of once per PDF
    // (each compileExtract otherwise re-reads every concept page, making a
    // multi-PDF ingest O(pdfs x concepts) on file reads).
    const vocab = deps.compile === false ? undefined : await loadAlignVocabulary(store);
    const results: PdfRunResult[] = [];
    for (const input of inputs) {
      results.push(await runOne(store, state, input, deps, vocab));
      await saveState(store, state);
    }
    await refreshRootIndex(store);
    return results;
  });
}

async function finishExtract(
  store: FileStore,
  record: PdfRecord,
  path: string,
  extractPath: string,
  extracted: ExtractResult,
  input: PdfInput,
  deps: PipelineDeps,
  vocab: AlignIndex | undefined,
): Promise<PdfRunResult> {
  if (deps.compile === false) {
    record.status = "queued";
    await appendLog(store, `extracted ${path} (compile skipped)`);
    return { path, status: "queued" };
  }
  return compileRecord(store, record, path, extractPath, extracted, input, deps, vocab);
}

async function compileRecord(
  store: FileStore,
  record: PdfRecord,
  path: string,
  extractPath: string,
  extracted: ExtractResult,
  input: PdfInput,
  deps: PipelineDeps,
  vocab: AlignIndex | undefined,
): Promise<PdfRunResult> {
  record.status = "compiling";
  const extractDoc = parseDocument(utf8Decode(await store.read(extractPath)));
  const tracking = new TrackingStore(store);
  try {
    const compiled = await compileExtract(
      tracking,
      deps.client,
      {
        extractText: extractDoc.body,
        extractPath,
        pdfFilename: input.filename.split("/").pop() ?? input.filename,
        pdfStorePath: path,
        pdfTitle: extracted.title,
        pdfAuthor: extracted.author,
        pdfCreationDate: extracted.creationDate,
      },
      { model: deps.model, now: deps.now, biblio: deps.biblio, alignVocabulary: vocab },
    );
    record.paper = compiled.paperPath;
    record.status = "done";
    await appendLog(store, `compiled ${path} → ${compiled.paperPath}`);
    return { path, status: "done" };
  } catch (error) {
    // Roll back only the files this compile touched, leaving any files written
    // concurrently by other jobs intact.
    await tracking.rollback();
    const message = error instanceof Error ? error.message : String(error);
    record.status = "compile_failed";
    record.error = message;
    await appendLog(store, `compile_failed ${path}: ${message}`);
    return { path, status: "compile_failed" };
  }
}

async function runOne(
  store: FileStore,
  state: PipelineState,
  input: PdfInput,
  deps: PipelineDeps,
  vocab: AlignIndex | undefined,
): Promise<PdfRunResult> {
  const path = pdfStorePath(input.filename);
  const hash = await sha256Hex(input.bytes);
  const existing = state.pdfs[path] ?? findByHash(state, hash);
  if (existing?.sha256 === hash && existing.status === "done") {
    await note(store, deps, `skip ${path} (same hash)`);
    return { path, status: "done", skipped: true };
  }

  const record: PdfRecord =
    existing?.sha256 === hash
      ? { ...existing, sha256: hash, error: undefined }
      : { sha256: hash, extractor: "text", status: "queued" };
  state.pdfs[path] = record;

  try {
    // Persist the uploaded bytes whenever the on-disk PDF is missing or its
    // recorded hash differs, so re-uploading different content under the same
    // filename actually updates the stored file (and state hash stays in sync
    // with disk; otherwise a later ingest would "skip" based on a hash the disk
    // no longer matches).
    if (!(await store.exists(path)) || existing?.sha256 !== hash) {
      await store.write(path, input.bytes);
    }

    record.status = "extracting";
    const extracted = await deps.extractor.extract(input.bytes, { path });
    const baseVisualPages = planVisualPages({
      needsVision: extracted.needsVision,
      pages: extracted.pages,
    });
    const imagePages = new Set(
      extracted.pages.filter((page) => page.hasImage).map((page) => page.page),
    );
    const visionPolicy = deps.vision?.mode ?? "auto";
    const visionMax = deps.vision?.maxPages ?? VISION_PAUSE_DEFAULT;
    let visualPages = baseVisualPages;
    let visionSkipped = false;
    if (visionPolicy === "skip" && !extracted.needsVision) {
      // Born-digital PDFs: figure pages are optional; true scans still need vision.
      visionSkipped = true;
    } else if (visionPolicy === "figures" && !extracted.needsVision) {
      visualPages = baseVisualPages.filter((page) => imagePages.has(page));
    } else if (typeof visionPolicy === "object") {
      const wanted = new Set(visionPolicy.pages);
      visualPages = baseVisualPages.filter((page) => wanted.has(page));
      if (visualPages.length === 0) {
        await note(store, deps, `${path} vision pages subset ${JSON.stringify(visionPolicy.pages)} matches none; skipping vision`);
      }
    }
    record.visionPages = visualPages;

    const extras = (partial: WriteExtractExtras): WriteExtractExtras => ({
      scan: extracted.needsVision,
      ...partial,
    });

    let previousVisual = "";
    let keptDone: number[] = [];
    if (existing?.sha256 === hash && existing.extract && (await store.exists(existing.extract))) {
      const prior = parseDocument(utf8Decode(await store.read(existing.extract)));
      previousVisual = visualSectionOf(prior.body, extracted.needsVision);
      keptDone = donePagesOf(existing, prior).filter((page) => visualPages.includes(page));
    }
    record.visionDone = keptDone;
    record.visionStatus = visualPages.length === 0 ? undefined : visionIsComplete(visualPages, keptDone) ? "complete" : "pending";

    let extractPath = await writeExtract(
      store,
      extracted,
      extras({
        extractor: previousVisual ? (extracted.needsVision ? "vision" : "hybrid") : "text",
        visualMarkdown: previousVisual || undefined,
        vision:
          visualPages.length > 0
            ? { status: record.visionStatus === "complete" ? "complete" : "pending", pages: visualPages, done: keptDone }
            : undefined,
      }),
    );
    record.extract = extractPath;

    if (visualPages.length === 0) {
      return finishExtract(store, record, path, extractPath, extracted, input, deps, vocab);
    }

    if (visionSkipped) {
      record.extractor = "text";
      record.visionStatus = "skipped";
      extractPath = await writeExtract(
        store,
        extracted,
        extras({
          extractor: "text",
          vision: { status: "skipped", pages: visualPages, done: [] },
        }),
      );
      record.extract = extractPath;
      await note(store, deps, `${path} vision skipped by user`);
      return finishExtract(store, record, path, extractPath, extracted, input, deps, vocab);
    }

    if (visionPolicy === "auto" && visualPages.length > visionMax) {
      record.status = "awaiting_vision";
      record.extractor = extracted.needsVision ? "vision" : "hybrid";
      await note(
        store,
        deps,
        `${path} awaiting_vision: ${visualPages.length} pages exceed budget ${visionMax} (${visualPages.join(",")}). ` +
          `Re-run okf_ingest with vision="all" (full), "figures" (figure pages only), "skip", or "pages:N,N,N".`,
      );
      return { path, status: "awaiting_vision" };
    }

    if (!deps.raster) {
      record.status = "needs_vision";
      record.extractor = extracted.needsVision ? "vision" : "hybrid";
      await note(store, deps, `${path} needs_vision (no raster)`);
      return { path, status: "needs_vision" };
    }

    const remaining = visualPages.filter((page) => !keptDone.includes(page));
    if (remaining.length === 0) {
      record.extractor = extracted.needsVision ? "vision" : "hybrid";
      record.visionStatus = "complete";
      await note(store, deps, `${path} vision already complete; compiling`);
      return finishExtract(store, record, path, extractPath, extracted, input, deps, vocab);
    }

    record.status = "extracting_vision";
    record.extractor = extracted.needsVision ? "vision" : "hybrid";
    await note(store, deps, `${path} vision ${remaining.length}/${visualPages.length} page(s) remaining`);
    const jpegByPage = new Map<number, Uint8Array>();
    for (const page of remaining) {
      jpegByPage.set(page, await deps.raster(input.bytes, page, { maxEdge: VISION_MAX_EDGE }));
    }
    const vision = await runVisionExtract({
      client: deps.client,
      jpegByPage,
      pages: remaining,
      retryDelayMs: deps.visionRetryDelayMs,
      onProgress: (line) => deps.onLog?.(line),
    });
    const done = [...keptDone, ...vision.done];
    record.visionDone = done;
    const complete = visionIsComplete(visualPages, done);
    record.visionStatus = complete ? "complete" : "pending";
    const visualMarkdown = joinVisualMarkdown(previousVisual, vision.markdown);
    extractPath = await writeExtract(
      store,
      extracted,
      extras({
        extractor: record.extractor,
        visualMarkdown,
        vision: { status: complete ? "complete" : "pending", pages: visualPages, done },
      }),
    );
    record.extract = extractPath;

    if (!complete) {
      record.status = "needs_vision";
      record.error = vision.error;
      await note(store, deps, `${path} needs_vision (incomplete: ${vision.failed.join(",")}${vision.error ? `; ${vision.error}` : ""})`);
      return { path, status: "needs_vision" };
    }

    return finishExtract(store, record, path, extractPath, extracted, input, deps, vocab);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record.status = "failed";
    record.error = message;
    await note(store, deps, `failed ${path}: ${message}`);
    return { path, status: "failed" };
  }
}

async function note(store: FileStore, deps: PipelineDeps, line: string): Promise<void> {
  deps.onLog?.(line);
  await appendLog(store, line);
}

function donePagesOf(record: PdfRecord, extract: ReturnType<typeof parseDocument>): number[] {
  const fromState = record.visionDone ?? [];
  const vision = extract.frontmatter.vision;
  const fromFile =
    vision && typeof vision === "object" && Array.isArray((vision as { done?: unknown }).done)
      ? (vision as { done: unknown[] }).done.filter((item): item is number => typeof item === "number")
      : [];
  return [...new Set([...fromState, ...fromFile])];
}
