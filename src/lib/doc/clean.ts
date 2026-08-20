/**
 * Light Markdown normalization for anydoc output (and the pdfjs fallback).
 *
 * anydoc already emits structured GFM, but real-world PDFs leak repeated page
 * furniture and journal chrome into the text layer. This strips:
 *  - journal "Downloaded from … by guest on …" / "… at … on …" page footers
 *    (both standalone lines and inline mid-paragraph),
 *  - inline HTML formatting tags anydoc emits for headers (u/i/b/em/sub/sup),
 *  - whole-line journal banners & printer markers ("**nature methods**",
 *    PLoS "ID: … — page N — #N", "N of M" page numbers, "OPEN ACCESS", …),
 * plus trailing spaces and blank-line runs.
 */

/** "Downloaded from https://… by guest on 29 October 2025" / "… at The Univ. … on July 19, 2025". */
const DOWNLOADED_FROM =
  /Downloaded from \S+(?: by guest on \d{1,2} \w+ \d{4}| at \S+ .+? on \w+ \d{1,2}, \d{4})?/gu;

/** Inline HTML formatting tags emitted by anydoc for header/emph runs. */
const INLINE_HTML_TAGS = /<\/?(?:u|i|b|em|strong|sub|sup)>/gu;

/** Whole lines that are journal furniture, never document content. */
const LINE_NOISE =
  /^(?:ID: [\w.]+ \u2014 \d{4}\/\d{1,2}\/\d{1,2} \u2014 page \d+ \u2014 #\d+|## PLOS [A-Z ]+|OPEN ACCESS|RESEARCH ARTICLE|\*\*(?:nature (?:methods|biotechnology|medicine|genetics|cancer|aging|energy|neuroscience))\*\*|\d{1,3} of \d{1,3})\s*$/u;

export function normalizeMarkdown(text: string): string {
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const cleaned = line
      .replace(INLINE_HTML_TAGS, "")
      .replace(DOWNLOADED_FROM, "")
      .replace(/[ \t]+$/u, "");
    if (LINE_NOISE.test(cleaned.trim())) {
      continue;
    }
    kept.push(cleaned);
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
