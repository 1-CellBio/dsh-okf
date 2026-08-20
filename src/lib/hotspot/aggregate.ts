import type { BundleIndex } from "@/lib/index/rebuild";
import { publishedYear } from "@/lib/okf/slug";

export type TopicCount = {
  id: string;
  title: string;
  count: number;
};

export type YearHotspot = {
  year: string;
  topics: TopicCount[];
};

// BundleIndex is an immutable rebuild snapshot, so per-index memoization is
// safe. Every agent query and coverage build would otherwise re-aggregate the
// whole corpus (O(N x outgoing)) from scratch.
const hotspotCache = new WeakMap<BundleIndex, YearHotspot[]>();

export function aggregateHotspots(index: BundleIndex): YearHotspot[] {
  const cached = hotspotCache.get(index);
  if (cached) {
    return cached;
  }
  const byYear = new Map<string, Map<string, number>>();

  for (const record of index.concepts.values()) {
    if (record.type !== "Paper" || !record.published) {
      continue;
    }
    const year = publishedYear(record.published);
    if (!year) {
      continue;
    }
    const topicCounts = byYear.get(year) ?? new Map<string, number>();
    const seenTopics = new Set<string>();
    for (const id of record.outgoing) {
      const target = index.concepts.get(id);
      if (!target || target.type !== "Topic") {
        continue;
      }
      if (seenTopics.has(id)) {
        continue;
      }
      seenTopics.add(id);
      topicCounts.set(id, (topicCounts.get(id) ?? 0) + 1);
    }
    byYear.set(year, topicCounts);
  }

  const result = [...byYear.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, topicCounts]) => ({
      year,
      topics: [...topicCounts.entries()]
        .map(([id, count]) => ({
          id,
          title: index.concepts.get(id)?.title ?? id,
          count,
        }))
        .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    }));
  hotspotCache.set(index, result);
  return result;
}
