export type ExtractorKind = "text" | "vision" | "ocr";

export type PdfPageExtract = {
  page: number;
  text: string;
  hasImage: boolean;
};

export type PdfExtract = {
  text: string;
  pageCount: number;
  pages: PdfPageExtract[];
  title?: string;
  author?: string;
  creationDate?: string;
  /** True when the anydoc text layer shows severe broken words (word-splitting). */
  brokenWords?: boolean;
};

export type RasterOptions = {
  maxEdge?: number;
};

export interface PdfEngine {
  extract(pdf: Uint8Array, source?: string): Promise<PdfExtract>;
  rasterPage?(pdf: Uint8Array, page: number, opts?: RasterOptions): Promise<Uint8Array>;
}

export type ExtractResult = PdfExtract & {
  needsVision: boolean;
  pdfPath: string;
};

export interface Extractor {
  readonly kind: ExtractorKind;
  extract(pdf: Uint8Array, meta: { path: string }): Promise<ExtractResult>;
}
