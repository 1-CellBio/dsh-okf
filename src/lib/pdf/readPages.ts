import type { PdfPageExtract } from "@/lib/extractors/types";

export function pdfItemText(item: unknown): string {
  if (item && typeof item === "object" && "str" in item && typeof item.str === "string") {
    return item.str;
  }
  return "";
}

export function pageHasImage(fnArray: number[], ops: Record<string, number>): boolean {
  const imageFns = [
    ops.paintImageXObject,
    ops.paintInlineImageXObject,
    ops.paintJpegXObject,
    ops.paintImageMaskXObject,
  ].filter((value): value is number => typeof value === "number");
  return fnArray.some((fn) => imageFns.includes(fn));
}

export async function readPdfPages(
  doc: {
    numPages: number;
    getPage: (n: number) => Promise<{
      getTextContent: () => Promise<{ items: unknown[] }>;
      getOperatorList: () => Promise<{ fnArray: number[] }>;
    }>;
  },
  ops: Record<string, number>,
): Promise<PdfPageExtract[]> {
  const pages: PdfPageExtract[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const operators = await page.getOperatorList();
    pages.push({
      page: pageNum,
      text: content.items.map(pdfItemText).join(" "),
      hasImage: pageHasImage(operators.fnArray, ops),
    });
  }
  return pages;
}

export function pdfMetaFields(info: Record<string, unknown>): {
  title?: string;
  author?: string;
  creationDate?: string;
} {
  return {
    title: typeof info.Title === "string" ? info.Title : undefined,
    author: typeof info.Author === "string" ? info.Author : undefined,
    creationDate: typeof info.CreationDate === "string" ? info.CreationDate : undefined,
  };
}
