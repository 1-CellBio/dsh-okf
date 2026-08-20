import { asString, asTags, displayDoi } from "@/lib/okf/identity";
import { publishedYear } from "@/lib/okf/slug";
import { isHighConfidence } from "./score";
import type { BiblioFields, BiblioFrontmatter, BiblioHit, BiblioSuggested } from "./types";

export type ApplyBiblioResult = {
  next: BiblioFields;
  applied: Array<"doi" | "authors" | "venue" | "published">;
  biblio?: BiblioFrontmatter;
};

function suggestedFrom(hit: BiblioHit): BiblioSuggested {
  return {
    ...(hit.doi ? { doi: hit.doi } : {}),
    ...(hit.title ? { title: hit.title } : {}),
    ...(hit.authors?.length ? { authors: hit.authors } : {}),
    ...(hit.venue ? { venue: hit.venue } : {}),
    ...(hit.published ? { published: hit.published } : {}),
  };
}

/** Year-only dates are stored as YYYY-01-01; a same-year Crossref date may be more precise. */
export function shouldApplyPublished(current?: string, incoming?: string): boolean {
  if (!incoming) {
    return false;
  }
  if (!current) {
    return true;
  }
  const currentYear = publishedYear(current);
  const incomingYear = publishedYear(incoming);
  if (!currentYear || !incomingYear || currentYear !== incomingYear) {
    return false;
  }
  const currentIsYearOnly = current.endsWith("-01-01");
  const incomingIsYearOnly = incoming.endsWith("-01-01");
  return currentIsYearOnly && !incomingIsYearOnly;
}

export function applyBiblio(current: BiblioFields, hit: BiblioHit | undefined): ApplyBiblioResult {
  if (!hit) {
    return { next: current, applied: [] };
  }
  if (!isHighConfidence(hit.score)) {
    return {
      next: current,
      applied: [],
      biblio: {
        status: "suggested",
        source: hit.source,
        score: hit.score,
        suggested: suggestedFrom(hit),
      },
    };
  }
  const applied: ApplyBiblioResult["applied"] = [];
  const next: BiblioFields = { ...current, title: current.title };
  if (!next.doi && hit.doi) {
    next.doi = hit.doi;
    applied.push("doi");
  }
  if ((!next.authors || next.authors.length === 0) && hit.authors?.length) {
    next.authors = hit.authors;
    applied.push("authors");
  }
  if (!next.venue && hit.venue) {
    next.venue = hit.venue;
    applied.push("venue");
  }
  if (shouldApplyPublished(next.published, hit.published)) {
    next.published = hit.published;
    applied.push("published");
  }
  return {
    next,
    applied,
    biblio: {
      status: "applied",
      source: hit.source,
      score: hit.score,
    },
  };
}

export function readBiblioFrontmatter(value: unknown): BiblioFrontmatter | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const status = asString(raw.status);
  const source = asString(raw.source);
  if (status !== "applied" && status !== "suggested" && status !== "skipped") {
    return undefined;
  }
  if (source !== "crossref" && source !== "openalex") {
    return undefined;
  }
  const score = typeof raw.score === "number" ? raw.score : Number(raw.score);
  const suggestedRaw =
    raw.suggested && typeof raw.suggested === "object"
      ? (raw.suggested as Record<string, unknown>)
      : undefined;
  return {
    status,
    source,
    score: Number.isFinite(score) ? score : 0,
    ...(suggestedRaw
      ? {
          suggested: {
            doi: displayDoi(suggestedRaw.doi),
            title: asString(suggestedRaw.title),
            authors: asTags(suggestedRaw.authors),
            venue: asString(suggestedRaw.venue),
            published: asString(suggestedRaw.published),
          },
        }
      : {}),
  };
}
