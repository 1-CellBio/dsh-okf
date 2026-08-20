/** Scan-like PDFs: too little text overall, or too little per page. */
export function needsVision(text: string, pageCount: number): boolean {
  if (text.length < 200) {
    return true;
  }
  if (pageCount >= 1 && text.length / pageCount < 80) {
    return true;
  }
  return false;
}
