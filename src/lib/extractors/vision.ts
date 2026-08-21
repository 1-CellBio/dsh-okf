import type { ChatClient } from "@/lib/providers/types";
import { mapPool } from "@/lib/pipeline/pool";
import { VISION_SYSTEM_PROMPT, visionUserText } from "./visionPrompt";

/** Two page images per request. Four JPEGs in one call often hit provider HTTP timeouts. */
export const VISION_BATCH_SIZE = 2;
/** How many batches transcribe in parallel. Vision dominates ingest wall time
 *  on scanned PDFs (serial = pages × per-call latency); three concurrent
 *  requests stay under typical provider rate limits. */
export const VISION_BATCH_CONCURRENCY = 3;
export const VISION_MAX_EDGE = 1280;
/** Retries for timeouts AND for outputs that fail the quality gate. */
export const VISION_TIMEOUT_RETRIES = 2;
export const VISION_RETRY_DELAY_MS = 1500;
/** A per-page vision section below this length counts as "not transcribed". */
export const VISION_MIN_SECTION_CHARS = 10;

export type VisionExtractResult = {
  markdown: string;
  done: number[];
  failed: number[];
  error?: string;
};

export type VisionExtractInput = {
  client: ChatClient;
  /** Optional pre-rastered JPEGs (tests). Prefer rasterPage so pages are
   *  rendered lazily — a 40-page scan should not hold 40 JPEGs at once. */
  jpegByPage?: Map<number, Uint8Array>;
  /** Raster a page on demand. Results are cached for retries of the same page. */
  rasterPage?: (page: number) => Promise<Uint8Array>;
  pages: number[];
  retryDelayMs?: number;
  onProgress?: (line: string) => void;
};

export function isRetryableVisionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed?\s*out|timeout|ETIMEDOUT|ECONNRESET|429|502|503|UNAVAILABLE/i.test(message);
}

function jpegToDataUrl(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
  }
  // btoa(String.fromCharCode(...bytes)) blows the V8 argument limit for large
  // JPEGs (~100KB+). Encode in chunks instead.
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

export async function runVisionExtract(input: VisionExtractInput): Promise<VisionExtractResult> {
  const delayMs = input.retryDelayMs ?? VISION_RETRY_DELAY_MS;
  const batches: number[][] = [];
  for (let offset = 0; offset < input.pages.length; offset += VISION_BATCH_SIZE) {
    batches.push(input.pages.slice(offset, offset + VISION_BATCH_SIZE));
  }
  // Batches run with bounded concurrency; mapPool keeps results in page order
  // so the assembled markdown preserves document order.
  const results = await mapPool(batches, VISION_BATCH_CONCURRENCY, async (batch) => {
    const result = await transcribeBatch(input, batch, delayMs);
    if (result.ok) {
      return { markdown: result.markdown, done: batch, failed: [] as number[], error: undefined as string | undefined };
    }
    // A whole-batch failure (timeout or quality gate) isolates better one page
    // at a time: a single bad page no longer drags down its neighbor.
    if (batch.length > 1) {
      input.onProgress?.(`vision batch ${batch.join(",")} failed (${result.error}); retrying one page at a time`);
      const markdowns: string[] = [];
      const done: number[] = [];
      const failed: number[] = [];
      let error: string | undefined;
      for (const page of batch) {
        const single = await transcribeBatch(input, [page], delayMs);
        if (single.ok) {
          markdowns.push(single.markdown);
          done.push(page);
        } else {
          failed.push(page);
          error = single.error;
        }
      }
      return { markdown: markdowns.filter(Boolean).join("\n\n"), done, failed, error };
    }
    return { markdown: "", done: [] as number[], failed: batch, error: result.error };
  });

  const chunks: string[] = [];
  const done: number[] = [];
  const failed: number[] = [];
  let error: string | undefined;
  for (const result of results) {
    if (result.markdown) {
      chunks.push(result.markdown);
    }
    done.push(...result.done);
    failed.push(...result.failed);
    if (result.error !== undefined) {
      error = result.error;
    }
  }

  return {
    markdown: chunks.join("\n\n"),
    done,
    failed,
    error,
  };
}

type BatchResult = { ok: true; markdown: string } | { ok: false; error: string };

async function transcribeBatch(
  input: VisionExtractInput,
  pages: number[],
  delayMs: number,
): Promise<BatchResult> {
  let lastError = "vision failed";
  const attempts = VISION_TIMEOUT_RETRIES + 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      input.onProgress?.(
        attempt === 1
          ? `vision pages ${pages.join(",")}`
          : `vision pages ${pages.join(",")} retry ${attempt - 1}/${VISION_TIMEOUT_RETRIES}`,
      );
      const raw = await completePages(input, pages);
      const check = checkVisionMarkdown(raw, pages);
      if (check.ok) {
        return { ok: true, markdown: raw.trim() };
      }
      // Quality gate failure (missing/empty page sections) is as retryable as a
      // timeout: a transient model glitch should not count as "transcribed".
      lastError = check.reason;
      if (attempt < attempts) {
        await sleep(delayMs * attempt);
        continue;
      }
      break;
    } catch (caught) {
      lastError = caught instanceof Error ? caught.message : String(caught);
      if (!isRetryableVisionError(caught) || attempt === attempts) {
        break;
      }
      await sleep(delayMs * attempt);
    }
  }
  return { ok: false, error: lastError };
}

type MarkdownCheck = { ok: true } | { ok: false; reason: string };

/** Returns the markdown between the "### Page n" heading and the next page heading. */
function pageSection(markdown: string, page: number): string | null {
  const heading = new RegExp(`### Page ${page}\\s*\\n`);
  const match = heading.exec(markdown);
  if (!match) {
    return null;
  }
  const start = match.index + match[0].length;
  const next = markdown.slice(start).search(/### Page \d+\s*\n/);
  const end = next < 0 ? markdown.length : start + next;
  return markdown.slice(start, end);
}

/** Every requested page must have its "### Page n" heading with real content. */
export function checkVisionMarkdown(markdown: string, pages: number[]): MarkdownCheck {
  const missing: number[] = [];
  const empty: number[] = [];
  for (const page of pages) {
    const section = pageSection(markdown, page);
    if (section === null) {
      missing.push(page);
    } else if (section.trim().length < VISION_MIN_SECTION_CHARS) {
      empty.push(page);
    }
  }
  if (missing.length > 0) {
    return { ok: false, reason: `missing headings for page(s) ${missing.join(",")}` };
  }
  if (empty.length > 0) {
    return { ok: false, reason: `near-empty output for page(s) ${empty.join(",")}` };
  }
  return { ok: true };
}

async function jpegFor(input: VisionExtractInput, page: number): Promise<Uint8Array> {
  const cached = input.jpegByPage?.get(page);
  if (cached) {
    return cached;
  }
  if (!input.rasterPage) {
    throw new Error(`missing raster for page ${page}`);
  }
  const jpeg = await input.rasterPage(page);
  const bag = input.jpegByPage ?? new Map<number, Uint8Array>();
  bag.set(page, jpeg);
  input.jpegByPage = bag;
  return jpeg;
}

async function completePages(input: VisionExtractInput, pages: number[]): Promise<string> {
  const images = await Promise.all(pages.map((page) => jpegFor(input, page)));
  const parts = [
    { type: "text" as const, text: visionUserText(pages) },
    ...images.map((jpeg) => ({
      type: "image_url" as const,
      image_url: { url: jpegToDataUrl(jpeg) },
    })),
  ];
  return input.client.complete([
    { role: "system", content: VISION_SYSTEM_PROMPT },
    { role: "user", content: parts },
  ]);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
