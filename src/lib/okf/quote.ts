/**
 * Quote matching against PDF extracts.
 * Folding joins PDF hyphenation and ignores trivial punctuation so LLM quotes
 * can snap back to a verbatim extract span. True paraphrases stay unmatched.
 */

export type FoldedQuote = {
  text: string;
  map: number[];
};

const SKIP_PUNCT = /[.,;:()[\]"'“”‘’\u2026]/;

export function foldQuote(source: string): FoldedQuote {
  const text = source.normalize("NFKC");
  const textParts: string[] = [];
  const map: number[] = [];
  let lastSpace = true;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\u00AD") {
      i += 1;
      continue;
    }
    if (c === "-" && i + 1 < text.length) {
      const wrap = text.slice(i + 1).match(/^(\s+)([a-z])/);
      if (wrap) {
        i += 1 + wrap[1]!.length;
        continue;
      }
    }
    if (/\s/.test(c)) {
      if (!lastSpace && textParts.length > 0) {
        textParts.push(" ");
        map.push(i);
        lastSpace = true;
      }
      i += 1;
      continue;
    }
    if (SKIP_PUNCT.test(c)) {
      i += 1;
      continue;
    }
    textParts.push(c.toLowerCase());
    map.push(i);
    lastSpace = false;
    i += 1;
  }
  if (textParts.at(-1) === " ") {
    textParts.pop();
    map.pop();
  }
  return { text: textParts.join(""), map };
}

export function normalizeQuote(text: string): string {
  return foldQuote(text).text;
}

export function quoteInExtract(quote: string, extract: string): boolean {
  const needle = foldQuote(quote).text;
  if (!needle) {
    return false;
  }
  return foldQuote(extract).text.includes(needle);
}

export function quoteFingerprint(quote: string): string {
  return foldQuote(quote).text.slice(0, 120);
}

function origSlice(source: string, folded: FoldedQuote, start: number, endExclusive: number): string {
  if (folded.map.length === 0 || start >= endExclusive) {
    return "";
  }
  const from = folded.map[start] ?? 0;
  const to = endExclusive < folded.map.length ? folded.map[endExclusive]! : source.length;
  return source.slice(from, to).trim();
}

function snapByWordAnchors(extract: string, q: FoldedQuote, e: FoldedQuote): string | undefined {
  const qw = q.text.split(" ").filter(Boolean);
  if (qw.length < 8) {
    return undefined;
  }
  const head = qw.slice(0, 4).join(" ");
  const tail = qw.slice(-4).join(" ");
  if (head.length < 12 || tail.length < 12) {
    return undefined;
  }
  const hs = e.text.indexOf(head);
  if (hs === -1) {
    return undefined;
  }
  const ts = e.text.indexOf(tail, hs);
  if (ts === -1) {
    return undefined;
  }
  const te = ts + tail.length;
  const windowLen = te - hs;
  const ratio = windowLen / q.text.length;
  if (ratio < 0.6 || ratio > 1.6) {
    return undefined;
  }
  const snapped = origSlice(extract, e, hs, te);
  return snapped || undefined;
}

/** Verbatim extract span for an LLM quote, or undefined if it cannot be aligned. */
export function snapQuoteToExtract(quote: string, extract: string): string | undefined {
  const source = extract.normalize("NFKC");
  const q = foldQuote(quote);
  const e = foldQuote(source);
  if (!q.text || !e.text) {
    return undefined;
  }
  const at = e.text.indexOf(q.text);
  if (at !== -1) {
    return origSlice(source, e, at, at + q.text.length) || undefined;
  }
  return snapByWordAnchors(source, q, e);
}
