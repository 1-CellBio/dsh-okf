import { formatFromBytes, formatFromExtension, toMarkdownBytes } from "@firecrawl/anydoc";
import type { Format } from "@firecrawl/anydoc";
import type { PdfEngine, PdfExtract, RasterOptions } from "@/lib/extractors/types";
import { PdfJsNodeEngine } from "@/lib/pdf/pdfjsNodeEngine";
import { detectBrokenWords } from "./brokenWords";
import { normalizeMarkdown } from "./clean";

/** Formats anydoc can convert natively (Format enum, keyed by extension). */
const ANYDOC_FORMATS = new Set<string>([
  "pdf",
  "doc",
  "docx",
  "odt",
  "ppt",
  "pptx",
  "rtf",
  "epub",
  "xlsx",
  "ods",
  "odp",
  "csv",
]);

/** Plain-text formats handled without anydoc. */
const TEXT_FORMATS = new Set<string>(["md", "txt"]);

function extensionOf(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export function isSupportedSource(filename: string): boolean {
  const ext = extensionOf(filename);
  return ANYDOC_FORMATS.has(ext) || TEXT_FORMATS.has(ext);
}

export function supportedFormats(): string {
  return [...ANYDOC_FORMATS].join(", ") + ", md, txt";
}

function isPdfBytes(bytes: Uint8Array): boolean {
  // PDF signature "%PDF-" within the first 1024 bytes.
  const head = bytes.subarray(0, Math.min(1024, bytes.length));
  const prefix = new TextDecoder().decode(head);
  return prefix.includes("%PDF-");
}

// @firecrawl/anydoc exposes Format as an ambient const enum, which is unusable
// as a value under verbatimModuleSyntax; its members are plain string literals.
const PDF_FORMAT = "pdf" as Format;

/**
 * Primary extraction engine.
 *
 * - PDF: anydoc (Rust) produces clean structured Markdown for the text layer;
 *   pdfjs still supplies per-page text/image info for vision planning and is
 *   the fallback when anydoc cannot read a PDF (image-only / scanned).
 * - Other formats (docx/pptx/xlsx/epub/rtf/csv/…): anydoc only, no pages and
 *   therefore no vision (vision rasterization applies to PDFs only).
 * - md/txt: read through as Markdown/text.
 */
export class AnyDocEngine implements PdfEngine {
  private readonly pdfjs = new PdfJsNodeEngine();

  async extract(pdf: Uint8Array, source?: string): Promise<PdfExtract> {
    const ext = extensionOf(source ?? "");
    if (ext === "pdf" || isPdfBytes(pdf)) {
      return this.extractPdf(pdf);
    }
    if (TEXT_FORMATS.has(ext)) {
      return {
        text: normalizeMarkdown(new TextDecoder().decode(pdf)),
        pageCount: 0,
        pages: [],
      };
    }
    const format = formatFromExtension(ext) ?? formatFromBytes(pdf) ?? undefined;
    const text = normalizeMarkdown(await toMarkdownBytes(pdf, format ?? null));
    return { text, pageCount: 0, pages: [] };
  }

  private async extractPdf(pdf: Uint8Array): Promise<PdfExtract> {
    const base = await this.pdfjs.extract(pdf);
    try {
      // anydoc (Rust) yields clean structured Markdown, preserving headings and
      // references that pdfjs loses to malformed word spacing.
      const text = normalizeMarkdown(await toMarkdownBytes(pdf, PDF_FORMAT));
      return { ...base, text, brokenWords: detectBrokenWords(text) };
    } catch {
      // anydoc rejects image-only (scanned) PDFs as unsupported; fall back to
      // pdfjs text so needsVision detection and the embedded text layer still work.
      return { ...base, text: normalizeMarkdown(base.text) };
    }
  }

  async rasterPage(pdf: Uint8Array, page: number, opts?: RasterOptions): Promise<Uint8Array> {
    return this.pdfjs.rasterPage(pdf, page, opts);
  }
}
