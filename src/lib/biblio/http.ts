import { displayDoi } from "@/lib/okf/identity";
import { normalizePublished } from "@/lib/okf/slug";

export type BiblioFetch = (url: string, init?: RequestInit) => Promise<Response>;

export function encodeDoiPath(doi: string): string {
  return displayDoi(doi)?.split("/").map(encodeURIComponent).join("/") ?? "";
}

export function withMailto(url: string, mailto?: string): string {
  if (!mailto?.trim()) {
    return url;
  }
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}mailto=${encodeURIComponent(mailto.trim())}`;
}

export async function fetchJson(
  fetchImpl: BiblioFetch,
  url: string,
): Promise<unknown | undefined> {
  try {
    const response = await fetchImpl(url);
    if (!response.ok) {
      console.error(`[okf] biblio request failed (HTTP ${response.status}): ${url}`);
      return undefined;
    }
    return await response.json();
  } catch (error) {
    console.error(`[okf] biblio request error: ${url}`, error instanceof Error ? error.message : error);
    return undefined;
  }
}

/** Builds a YYYY-MM-DD string; impossible months/days are rejected. */
export function datePartsToPublished(parts: unknown): string | undefined {
  if (!Array.isArray(parts) || typeof parts[0] !== "number") {
    return undefined;
  }
  const year = String(parts[0]);
  const month = typeof parts[1] === "number" ? String(parts[1]).padStart(2, "0") : "01";
  const day = typeof parts[2] === "number" ? String(parts[2]).padStart(2, "0") : "01";
  return normalizePublished(`${year}-${month}-${day}`);
}
