import type { PdfPageExtract } from "./types";

export const THIN_PAGE_CHARS = 80;

export function planVisualPages(input: {
  needsVision: boolean;
  pages: PdfPageExtract[];
}): number[] {
  if (input.needsVision) {
    return input.pages.map((page) => page.page);
  }
  return input.pages
    .filter((page) => page.hasImage || page.text.length < THIN_PAGE_CHARS)
    .map((page) => page.page);
}
