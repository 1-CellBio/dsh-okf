import { alignTokens, TOKEN_ALIGN_TYPES, tokenMatch, tokensEqual } from "@/lib/compile/tokens";

export type HubTitle = {
  type: string;
  path: string;
  title: string;
  aliases: string[];
};

const EDIT_AUTO = 2;
const EDIT_MIN_LEN = 6;

function compactKey(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/^(the|an|a)\s+/u, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

/** COL5A1 vs COL4A1 is edit-distance 1 but they are distinct catalog symbols. */
export function catalogSymbolPair(a: string, b: string): boolean {
  const compact = (value: string): string => value.replace(/[^a-z0-9]+/gi, "");
  const symbol = (value: string): boolean =>
    value.length <= 16 && /[0-9]/.test(value) && /^[a-z0-9]+$/i.test(value);
  const left = compact(a);
  const right = compact(b);
  return symbol(left) && symbol(right) && left !== right;
}

/** Cellpose vs Cellpose3, FA2 vs FA2.1 — same stem, different version. */
export function looksLikeVersionPair(a: string, b: string): boolean {
  const base = (value: string): string =>
    value.toLowerCase().replace(/[\s._-]*v?\d+(\.\d+)*$/i, "").trim();
  const left = base(a);
  const right = base(b);
  return Boolean(left) && left === right && a.replace(/\s+/g, "") !== b.replace(/\s+/g, "");
}

export function parentheticals(title: string): string[] {
  const out: string[] = [];
  for (const match of title.matchAll(/\(([^)]+)\)/gu)) {
    const inner = match[1]?.trim() ?? "";
    if (inner && compactKey(inner) !== compactKey(title)) {
      out.push(inner);
    }
  }
  return out;
}

/** Levenshtein with early exit above `maxDist` (returns 99 when too far). */
export function levenshtein(a: string, b: string, maxDist = EDIT_AUTO): number {
  if (a === b) {
    return 0;
  }
  if (!a.length) {
    return b.length;
  }
  if (!b.length) {
    return a.length;
  }
  if (Math.abs(a.length - b.length) > maxDist) {
    return 99;
  }
  const prev = Array.from({ length: b.length + 1 }, (_, index) => index);
  const curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0] ?? i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 99) + 1, (curr[j - 1] ?? 99) + 1, (prev[j - 1] ?? 99) + cost);
      if ((curr[j] ?? 99) < rowMin) {
        rowMin = curr[j] ?? 99;
      }
    }
    if (rowMin > maxDist) {
      return 99;
    }
    for (let j = 0; j <= b.length; j++) {
      prev[j] = curr[j] ?? 99;
    }
  }
  return prev[b.length] ?? 99;
}

/**
 * High-confidence same-hub? Safe to canonicalize without a human.
 * Versioned tools and gene-like catalog symbols are never auto-merged.
 */
export function autoMergeReason(a: HubTitle, b: HubTitle): string | undefined {
  if (a.type !== b.type || a.path === b.path) {
    return undefined;
  }
  if (looksLikeVersionPair(a.title, b.title)) {
    return undefined;
  }
  const ka = compactKey(a.title);
  const kb = compactKey(b.title);
  if (catalogSymbolPair(ka, kb)) {
    return undefined;
  }
  if (ka && ka === kb) {
    return "align:title";
  }
  const aKeys = new Set([ka, ...a.aliases.map(compactKey), ...parentheticals(a.title).map(compactKey)]);
  const bKeys = new Set([kb, ...b.aliases.map(compactKey), ...parentheticals(b.title).map(compactKey)]);
  for (const key of aKeys) {
    if (key && bKeys.has(key) && !catalogSymbolPair(key, ka === key ? kb : ka)) {
      return "align:alias";
    }
  }
  if (a.type === "Gene") {
    return undefined;
  }
  if (ka.length >= EDIT_MIN_LEN && kb.length >= EDIT_MIN_LEN) {
    const dist = levenshtein(ka, kb);
    if (dist > 0 && dist <= EDIT_AUTO) {
      return `edit-distance:${dist}`;
    }
  }
  if (!TOKEN_ALIGN_TYPES.has(a.type)) {
    return undefined;
  }
  const setsA = [alignTokens(a.title), ...a.aliases.map(alignTokens), ...parentheticals(a.title).map(alignTokens)];
  const setsB = [alignTokens(b.title), ...b.aliases.map(alignTokens), ...parentheticals(b.title).map(alignTokens)];
  for (const left of setsA) {
    for (const right of setsB) {
      if (tokensEqual(left, right)) {
        return "token:equal";
      }
      const contain = tokenMatch(left, right) ?? tokenMatch(right, left);
      if (contain === "equal") {
        return "token:equal";
      }
      if (contain === "existing-in-incoming" && Math.abs(left.length - right.length) <= 2) {
        return "token:contain";
      }
    }
  }
  return undefined;
}
