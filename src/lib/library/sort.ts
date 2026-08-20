import type { BundleIndex } from "@/lib/index/rebuild";
import type { ConceptRecord } from "@/types/okf";

export function libraryPapers(index: BundleIndex): ConceptRecord[] {
  return [...index.concepts.values()]
    .filter((record) => record.type === "Paper")
    .sort((a, b) => {
      if (a.published && b.published && a.published !== b.published) {
        return b.published.localeCompare(a.published);
      }
      if (a.published && !b.published) {
        return -1;
      }
      if (!a.published && b.published) {
        return 1;
      }
      return (a.title ?? a.id).localeCompare(b.title ?? b.id);
    });
}

export function filterByPublishedRange(
  papers: ConceptRecord[],
  from?: string,
  to?: string,
): ConceptRecord[] {
  return papers.filter((paper) => {
    if (!from && !to) {
      return true;
    }
    if (!paper.published) {
      return false;
    }
    if (from && paper.published < from) {
      return false;
    }
    if (to && paper.published > to) {
      return false;
    }
    return true;
  });
}
