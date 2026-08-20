import { displayDoi } from "@/lib/okf/identity";
import { datePartsToPublished, encodeDoiPath, fetchJson, withMailto, type BiblioFetch } from "./http";
import { scoreBiblioHit } from "./score";
import type { BiblioHit, BiblioLookup } from "./types";

export const CROSSREF_WORKS = "https://api.crossref.org/works";

type CrossrefWork = {
  DOI?: string;
  title?: string[];
  author?: Array<{ given?: string; family?: string; name?: string }>;
  "container-title"?: string[];
  issued?: { "date-parts"?: unknown[] };
  "published-print"?: { "date-parts"?: unknown[] };
  "published-online"?: { "date-parts"?: unknown[] };
};

function authorName(author: { given?: string; family?: string; name?: string }): string | undefined {
  if (author.name?.trim()) {
    return author.name.trim();
  }
  const name = [author.given, author.family].filter(Boolean).join(" ").trim();
  return name || undefined;
}

export function parseCrossrefWork(work: CrossrefWork): Omit<BiblioHit, "score"> | undefined {
  const title = work.title?.[0]?.trim();
  const doi = displayDoi(work.DOI);
  if (!title && !doi) {
    return undefined;
  }
  const authors = (work.author ?? []).map(authorName).filter((name): name is string => Boolean(name));
  const venue = work["container-title"]?.[0]?.trim();
  const published =
    datePartsToPublished(work.issued?.["date-parts"]?.[0]) ??
    datePartsToPublished(work["published-print"]?.["date-parts"]?.[0]) ??
    datePartsToPublished(work["published-online"]?.["date-parts"]?.[0]);
  return {
    source: "crossref",
    ...(doi ? { doi } : {}),
    ...(title ? { title } : {}),
    ...(authors.length > 0 ? { authors } : {}),
    ...(venue ? { venue } : {}),
    ...(published ? { published } : {}),
  };
}

export function createCrossrefClient(options: { fetch?: BiblioFetch; mailto?: string } = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const mailto = options.mailto;

  async function byDoi(doi: string): Promise<BiblioHit | undefined> {
    const encoded = encodeDoiPath(doi);
    if (!encoded) {
      return undefined;
    }
    const json = (await fetchJson(fetchImpl, withMailto(`${CROSSREF_WORKS}/${encoded}`, mailto))) as
      | { message?: CrossrefWork }
      | undefined;
    const parsed = json?.message ? parseCrossrefWork(json.message) : undefined;
    return parsed ? { ...parsed, score: 1 } : undefined;
  }

  async function search(query: BiblioLookup): Promise<BiblioHit | undefined> {
    if (!query.title?.trim()) {
      return undefined;
    }
    const params = new URLSearchParams({
      "query.bibliographic": query.title.trim(),
      rows: "5",
    });
    if (query.year) {
      params.set("filter", `from-pub-date:${query.year},until-pub-date:${query.year}`);
    }
    const json = (await fetchJson(
      fetchImpl,
      withMailto(`${CROSSREF_WORKS}?${params.toString()}`, mailto),
    )) as { message?: { items?: CrossrefWork[] } } | undefined;
    let best: BiblioHit | undefined;
    for (const item of json?.message?.items ?? []) {
      const parsed = parseCrossrefWork(item);
      if (!parsed) {
        continue;
      }
      const scored = { ...parsed, score: scoreBiblioHit(query, parsed) };
      if (!best || scored.score > best.score) {
        best = scored;
      }
    }
    return best;
  }

  return { byDoi, search };
}
