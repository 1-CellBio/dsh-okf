export const PASSAGE_MIN = 400;
export const PASSAGE_MAX = 800;
export const PASSAGE_LIMIT = 3;

function latinTerms(text: string): string[] {
  return text.match(/[A-Za-z][A-Za-z0-9+-]{1,}/g) ?? [];
}

/** CJK has no spaces; split each run into overlapping bigrams so a long query
 * can still match fragments of the passage. */
function cjkBigrams(text: string): string[] {
  const runs = text.match(/[\u4e00-\u9fff]+/g) ?? [];
  const out: string[] = [];
  for (const run of runs) {
    if (run.length <= 2) {
      out.push(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) {
      out.push(run.slice(i, i + 2));
    }
  }
  return out;
}

export function passageTerms(query: string): string[] {
  const lowered = query.toLowerCase();
  const spaced = lowered.split(/\s+/).filter((term) => term.length >= 2);
  const latin = latinTerms(query).map((term) => term.toLowerCase());
  return [...new Set([...spaced, ...latin, ...cjkBigrams(lowered)])];
}

export function splitPassages(
  body: string,
  options?: { min?: number; max?: number },
): string[] {
  const min = options?.min ?? PASSAGE_MIN;
  const max = options?.max ?? PASSAGE_MAX;
  const paras = body
    .split(/\n\s*\n/)
    .map((para) => para.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (paras.length === 0) {
    const compact = body.replace(/\s+/g, " ").trim();
    return compact ? [compact.slice(0, max)] : [];
  }
  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      chunks.push(buf);
      buf = "";
    }
  };
  for (const para of paras) {
    if (para.length <= max) {
      if (!buf) {
        buf = para;
        continue;
      }
      if (buf.length < min && buf.length + 1 + para.length <= max) {
        buf = `${buf} ${para}`;
      } else {
        flush();
        buf = para;
      }
      continue;
    }
    // A paragraph longer than `max`: flush any pending short buffer, then split
    // the paragraph into `max`-sized pieces so no trailing text is ever dropped.
    flush();
    for (let offset = 0; offset < para.length; offset += max) {
      chunks.push(para.slice(offset, offset + max));
    }
  }
  if (buf) {
    chunks.push(buf);
  }
  return chunks;
}

export function scorePassage(text: string, query: string): number {
  const hay = text.toLowerCase();
  let score = 0;
  for (const term of passageTerms(query)) {
    if (hay.includes(term)) {
      score += 1;
    }
  }
  return score;
}

export function selectPassages(
  body: string,
  query: string,
  limit = PASSAGE_LIMIT,
): string[] {
  const chunks = splitPassages(body);
  if (chunks.length === 0) {
    return [];
  }
  const ranked = chunks
    .map((text) => ({ text, score: scorePassage(text, query) }))
    .sort((a, b) => b.score - a.score);
  const positive = ranked.filter((item) => item.score > 0).slice(0, limit);
  if (positive.length > 0) {
    return positive.map((item) => item.text);
  }
  return chunks.slice(0, limit);
}
