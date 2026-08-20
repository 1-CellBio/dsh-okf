import { displayDoi } from "@/lib/okf/identity";
import { normalizePublished } from "@/lib/okf/slug";
import { encodeDoiPath, fetchJson, withMailto, type BiblioFetch } from "./http";
import { scoreBiblioHit } from "./score";
import type { BiblioHit, BiblioLookup } from "./types";

export const OPENALEX_WORKS = "https://api.openalex.org/works";

type OpenAlexWork = {
  doi?: string;
  title?: string;
  display_name?: string;
  publication_year?: number;
  publication_date?: string;
  authorships?: Array<{ author?: { display_name?: string } }>;
  primary_location?: { source?: { display_name?: string } };
};

export function parseOpenAlexWork(work: OpenAlexWork): Omit<BiblioHit, "score"> | undefined {
  const title = work.title?.trim() || work.display_name?.trim();
  const doi = displayDoi(work.doi);
  if (!title && !doi) {
    return undefined;
  }
  const authors = (work.authorships ?? [])
    .map((item) => item.author?.display_name?.trim())
    .filter((name): name is string => Boolean(name));
  const venue = work.primary_location?.source?.display_name?.trim();
  const published =
    normalizePublished(work.publication_date?.trim() ?? "") ||
    (typeof work.publication_year === "number" ? `${work.publication_year}-01-01` : undefined);
  return {
    source: "openalex",
    ...(doi ? { doi } : {}),
    ...(title ? { title } : {}),
    ...(authors.length > 0 ? { authors } : {}),
    ...(venue ? { venue } : {}),
    ...(published ? { published } : {}),
  };
}

export function createOpenAlexClient(options: { fetch?: BiblioFetch; mailto?: string } = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const mailto = options.mailto;

  async function byDoi(doi: string): Promise<BiblioHit | undefined> {
    const encoded = encodeDoiPath(doi);
    if (!encoded) {
      return undefined;
    }
    const json = (await fetchJson(
      fetchImpl,
      withMailto(`${OPENALEX_WORKS}/https://doi.org/${encoded}`, mailto),
    )) as OpenAlexWork | undefined;
    const parsed = json ? parseOpenAlexWork(json) : undefined;
    return parsed ? { ...parsed, score: 1 } : undefined;
  }

  async function search(query: BiblioLookup): Promise<BiblioHit | undefined> {
    if (!query.title?.trim()) {
      return undefined;
    }
    const params = new URLSearchParams({
      search: query.title.trim(),
      "per-page": "5",
    });
    if (query.year) {
      params.set("filter", `publication_year:${query.year}`);
    }
    const json = (await fetchJson(
      fetchImpl,
      withMailto(`${OPENALEX_WORKS}?${params.toString()}`, mailto),
    )) as { results?: OpenAlexWork[] } | undefined;
    let best: BiblioHit | undefined;
    for (const item of json?.results ?? []) {
      const parsed = parseOpenAlexWork(item);
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
