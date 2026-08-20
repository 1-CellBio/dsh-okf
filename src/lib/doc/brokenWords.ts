/**
 * Broken-word detection for the anydoc text layer.
 *
 * anydoc reconstructs a PDF's text layer into Markdown; for some PDFs (e.g.
 * Science Advances) it splits words mid-token, producing pairs like
 * "C opyright", "T he", "D istributed" that pdfjs's raw text layer does not
 * contain. Legitimate single-capital + word pairs ("T cells", "P axis",
 * figure-panel references like "Note D in S1 Text") do occur but are rare
 * (a handful per clean document), so a plain count separates the two cleanly:
 * the motivating Science Advances paper yields ~300+ hits while clean
 * documents stay below ~50.
 *
 * A document above the threshold is treated as needing full-document vision
 * (the vision model re-reads pixels, producing clean text) — no OCR install.
 */

/** Single capital letter (not A/I) + space + lowercase word: "C opyright", "T he". */
const CAPITAL_MIDWORD = /\b(?![AI]\b)[B-Z] [a-z]{2,}\b/g;

/** Absolute hit count beyond which a document is considered broken. */
export const BROKEN_WORD_THRESHOLD = 80;

export function countBrokenWords(markdown: string): number {
  const matches = markdown.match(CAPITAL_MIDWORD);
  return matches ? matches.length : 0;
}

/** True when the anydoc Markdown shows severe word-splitting (broken words). */
export function detectBrokenWords(markdown: string): boolean {
  return countBrokenWords(markdown) >= BROKEN_WORD_THRESHOLD;
}
