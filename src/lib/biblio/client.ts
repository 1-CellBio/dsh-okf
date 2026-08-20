import { displayDoi } from "@/lib/okf/identity";
import { createCrossrefClient } from "./crossref";
import type { BiblioFetch } from "./http";
import { createOpenAlexClient } from "./openalex";
import type { BiblioClient, BiblioHit, BiblioLookup } from "./types";

export type CreateBiblioClientOptions = {
  fetch?: BiblioFetch;
  mailto?: string;
  enabled?: boolean;
};

export function biblioEnabledFromEnv(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): boolean {
  const raw = env.KG_BIBLIO?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

export function biblioMailtoFromEnv(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): string | undefined {
  return env.KG_MAILTO?.trim() || env.CROSSREF_MAILTO?.trim() || env.OPENALEX_MAILTO?.trim() || undefined;
}

export function createBiblioClientFromEnv(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
  fetchImpl?: BiblioFetch,
): BiblioClient | undefined {
  if (!biblioEnabledFromEnv(env)) {
    return undefined;
  }
  return createBiblioClient({ fetch: fetchImpl, mailto: biblioMailtoFromEnv(env) });
}

export function createBiblioClient(options: CreateBiblioClientOptions = {}): BiblioClient {
  const enabled = options.enabled ?? true;
  const crossref = createCrossrefClient({ fetch: options.fetch, mailto: options.mailto });
  const openalex = createOpenAlexClient({ fetch: options.fetch, mailto: options.mailto });

  return {
    async lookup(query: BiblioLookup): Promise<BiblioHit | undefined> {
      if (!enabled) {
        return undefined;
      }
      const doi = displayDoi(query.doi);
      if (doi) {
        const byDoi = (await crossref.byDoi(doi)) ?? (await openalex.byDoi(doi));
        if (byDoi) {
          return byDoi;
        }
      }
      if (!query.title?.trim()) {
        return undefined;
      }
      return (await crossref.search(query)) ?? (await openalex.search(query));
    },
  };
}
