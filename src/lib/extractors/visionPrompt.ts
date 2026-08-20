export const VISION_SYSTEM_PROMPT = `You transcribe scientific PDF page images into Markdown.
Return ONLY Markdown with one heading per page you were given, in this exact form:
### Page {n}

Rules:
- Transcribe tables as GitHub-flavored markdown tables.
- Transcribe figure captions and axis labels.
- Transcribe equations as LaTeX.
- Do not summarize as "see figure". Do not omit a page that was in the request.
- Do not invent citations, DOIs, or paper ids.`;

export function visionUserText(pages: number[]): string {
  return `Transcribe these PDF pages in full: ${pages.join(", ")}. Use a ### Page N heading for each.`;
}
