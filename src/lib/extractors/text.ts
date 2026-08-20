import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { generatedBy } from "@/lib/okf/generated";
import { asString, displayDoi, paperConceptId } from "@/lib/okf/identity";
import { parseDocument } from "@/lib/okf/parse";
import { serializeDocument } from "@/lib/okf/serialize";
import { mergeVisualBody } from "./mergeVisual";
import type { Extractor, ExtractorKind, ExtractResult, PdfEngine } from "./types";
import { needsVision } from "./needsVision";

export function pdfStem(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[^./]+$/u, "");
}

export type VisionWriteMeta = {
  status: "complete" | "pending" | "skipped";
  pages: number[];
  done: number[];
};

export type WriteExtractExtras = {
  extractor?: ExtractorKind | "hybrid";
  vision?: VisionWriteMeta;
  visualMarkdown?: string;
  scan?: boolean;
};

export class TextExtractor implements Extractor {
  readonly kind = "text" as const;

  constructor(private readonly engine: PdfEngine) {}

  async extract(pdf: Uint8Array, meta: { path: string }): Promise<ExtractResult> {
    const raw = await this.engine.extract(pdf, meta.path);
    return {
      ...raw,
      pdfPath: meta.path,
      // Non-PDF sources report pageCount 0 (no pages/vision); never classify
      // them as scan-like. PDFs with severe broken words are routed to full
      // vision too: the vision model re-reads pixels and produces clean text.
      needsVision:
        raw.pageCount > 0 && (needsVision(raw.text, raw.pageCount) || raw.brokenWords === true),
    };
  }
}

export async function writeExtract(
  store: FileStore,
  result: ExtractResult,
  extras: WriteExtractExtras = {},
): Promise<string> {
  const stem = pdfStem(result.pdfPath);
  const path = `extracts/${stem}.md`;
  let paper: string | undefined;
  let doi: string | undefined;
  if (await store.exists(path)) {
    const existing = parseDocument(utf8Decode(await store.read(path)));
    paper = asString(existing.frontmatter.paper)
      ? paperConceptId(String(existing.frontmatter.paper))
      : undefined;
    doi = displayDoi(existing.frontmatter.doi);
  }
  const body = extras.visualMarkdown
    ? mergeVisualBody(result.text, extras.visualMarkdown, Boolean(extras.scan))
    : result.text;
  const generatedByValue =
    extras.extractor === "vision"
      ? generatedBy("vision-extractor")
      : extras.extractor === "hybrid"
        ? generatedBy("hybrid-extractor")
        : generatedBy("text-extractor");
  const markdown = serializeDocument(
    {
      type: "TextExtract",
      title: result.title ?? stem,
      resource: `/${result.pdfPath.replace(/^\/+/, "")}`,
      extractor: extras.extractor ?? "text",
      generated: {
        by: generatedByValue,
        at: new Date().toISOString(),
      },
      ...(extras.vision ? { vision: extras.vision } : {}),
      ...(result.brokenWords ? { brokenWords: true } : {}),
      ...(paper ? { paper } : {}),
      ...(doi ? { doi } : {}),
    },
    body,
  );
  await store.write(path, markdown);
  return path;
}
