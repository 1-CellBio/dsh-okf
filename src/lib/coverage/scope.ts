import type { BundleIndex } from "@/lib/index/rebuild";
import { retrieve } from "@/lib/retrieve/query";
import type { CoverageScope } from "./matrix";

export function looksLikeCoverageQuery(text: string): boolean {
  return /缺口|空白|缺年|覆盖|coverage|\bgap\b|missing year|which years|未定期/i.test(text);
}

export function inferCoverageScope(index: BundleIndex, userText: string): CoverageScope {
  const years = [...userText.matchAll(/\b((?:19|20)\d{2})\b/g)]
    .map((match) => match[1])
    .filter((year): year is string => Boolean(year));
  const from = years.length > 0 ? years.reduce((a, b) => (a < b ? a : b)) : undefined;
  const to = years.length > 0 ? years.reduce((a, b) => (a > b ? a : b)) : undefined;
  const topicHit = retrieve(index, { text: userText, type: "Topic", stableOnly: true })[0];
  return { topic: topicHit?.id, from, to };
}
