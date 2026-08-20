import { getDocument, GlobalWorkerOptions, OPS } from "pdfjs-dist";
import type { PdfEngine, PdfExtract, RasterOptions } from "@/lib/extractors/types";
import { pdfMetaFields, readPdfPages } from "./readPages";
import { PDFJS_WORKER_SRC } from "./workerSrc";

function ensureWorker(): void {
  if (!GlobalWorkerOptions.workerSrc) {
    GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
  }
}

export function pdfjsWorkerSrc(): string {
  return PDFJS_WORKER_SRC;
}

function createCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(w, h);
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }
  throw new Error("PDF rasterization requires a canvas (use the Chrome workbench)");
}

async function canvasJpeg(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Uint8Array> {
  if ("convertToBlob" in canvas) {
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
    return new Uint8Array(await blob.arrayBuffer());
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (next) => (next ? resolve(next) : reject(new Error("canvas toBlob failed"))),
      "image/jpeg",
      0.7,
    );
  });
  return new Uint8Array(await blob.arrayBuffer());
}

export class PdfJsEngine implements PdfEngine {
  async extract(pdf: Uint8Array): Promise<PdfExtract> {
    ensureWorker();
    const data = pdf.slice();
    const doc = await getDocument({ data, useSystemFonts: true }).promise;
    try {
      const pages = await readPdfPages(doc, OPS);
      const meta = await doc.getMetadata().catch(() => null);
      const info = (meta?.info ?? {}) as Record<string, unknown>;
      return {
        text: pages
          .map((page) => page.text)
          .join("\n")
          .trim(),
        pageCount: doc.numPages,
        pages,
        ...pdfMetaFields(info),
      };
    } finally {
      doc.cleanup();
    }
  }

  async rasterPage(pdf: Uint8Array, page: number, opts?: RasterOptions): Promise<Uint8Array> {
    ensureWorker();
    const maxEdge = opts?.maxEdge ?? 1280;
    const data = pdf.slice();
    const doc = await getDocument({ data, useSystemFonts: true }).promise;
    try {
      const pdfPage = await doc.getPage(page);
      const base = pdfPage.getViewport({ scale: 1 });
      const scale = Math.min(2, maxEdge / Math.max(base.width, base.height, 1));
      const viewport = pdfPage.getViewport({ scale });
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("2D canvas context unavailable");
      }
      await pdfPage.render({ canvas: null, canvasContext: ctx as CanvasRenderingContext2D, viewport }).promise;
      return canvasJpeg(canvas);
    } finally {
      doc.cleanup();
    }
  }
}
