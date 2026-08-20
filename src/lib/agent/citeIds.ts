const CITE_ID_RE =
  /\b((?:papers|claims|topics|methods|entities|notes|questions|surveys)\/[A-Za-z0-9][A-Za-z0-9._/-]*)/g;

export function extractCiteIds(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  CITE_ID_RE.lastIndex = 0;
  for (const match of text.matchAll(CITE_ID_RE)) {
    const raw = (match[1] ?? "").replace(/\.md$/i, "").replace(/[.,;:)]+$/u, "");
    if (!raw || seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    ids.push(raw);
  }
  return ids;
}
