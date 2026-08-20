import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { getDocument, GlobalWorkerOptions, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PdfEngine, PdfExtract, RasterOptions } from "@/lib/extractors/types";
import { pdfMetaFields, readPdfPages } from "./readPages";

const require = createRequire(import.meta.url);

function ensureCanvasGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  g.DOMMatrix = DOMMatrix;
  g.ImageData = ImageData;
  g.Path2D = Path2D;
}

function ensureWorker(): void {
  if (GlobalWorkerOptions.workerSrc) {
    return;
  }
  const workerPath = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
}

// pdfjs-dist 6.x ships the JBIG2/openjpeg decoders as wasm modules that must
// be located via the wasmUrl parameter; without it every JBIG2-encoded XObject
// fails to initialize ("JBig2 failed to initialize") and rasterizes blank —
// a silent quality killer for scanned pages routed to vision.
let wasmUrlCache = "";
function wasmDirUrl(): string {
  if (!wasmUrlCache) {
    const main = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
    const dir = path.join(path.dirname(main), "..", "..", "wasm");
    wasmUrlCache = pathToFileURL(dir + path.sep).href;
  }
  return wasmUrlCache;
}

ensureCanvasGlobals();

/** pdf.js text extract + JPEG raster for Node (legacy build + @napi-rs/canvas). */
export class PdfJsNodeEngine implements PdfEngine {
  async extract(pdf: Uint8Array): Promise<PdfExtract> {
    ensureWorker();
    const data = pdf.slice();
    const doc = await getDocument({ data, useSystemFonts: true, wasmUrl: wasmDirUrl() }).promise;
    try {
      const pages = await readPdfPages(doc, OPS as unknown as Record<string, number>);
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
    ensureCanvasGlobals();
    const maxEdge = opts?.maxEdge ?? 1280;
    const data = pdf.slice();
    const doc = await getDocument({ data, useSystemFonts: true, wasmUrl: wasmDirUrl() }).promise;
    try {
      const pdfPage = await doc.getPage(page);
      const base = pdfPage.getViewport({ scale: 1 });
      const scale = Math.min(2, maxEdge / Math.max(base.width, base.height, 1));
      const viewport = pdfPage.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d");
      await pdfPage.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      const jpeg = await canvas.encode("jpeg", 70);
      return new Uint8Array(jpeg);
    } finally {
      doc.cleanup();
    }
  }
}
