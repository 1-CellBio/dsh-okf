/** Scan-like PDFs: almost no text, or too little text per page.
 * Image-heavy born-digital papers with a real text layer are not scans —
 * figure pages are still sent to vision via planVisualPages(hasImage). */
export function needsVision(input: {
  text: string;
  pageCount: number;
  imagePages?: number;
  brokenWords?: boolean;
}): boolean {
  if (input.brokenWords) {
    return true;
  }
  const text = input.text;
  const pages = Math.max(1, input.pageCount);
  if (text.length < 200) {
    return true;
  }
  if (text.length / pages >= 80) {
    return false;
  }
  const imagePages = input.imagePages ?? 0;
  // Sparse because of figures/plates, but there is still a running text layer.
  if (text.length >= 1500 && imagePages > 0) {
    return false;
  }
  return true;
}
