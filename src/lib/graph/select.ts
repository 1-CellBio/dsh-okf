import type { ConceptRecord } from "@/types/okf";
import { selectFairClaims } from "./fairClaims";

/**
 * Pick which concept records to draw when the library is larger than `cap`.
 *
 * Naive `slice(0, cap)` by type-rank keeps Papers and drops the Topic/Method
 * hubs they link to, which produces a disconnected scatter. This keeps every
 * paper that fits, then the hubs those papers actually touch (highest degree
 * first), and only then fills leftover slots with fairly distributed claims.
 */
export function selectCappedGraph(
  overview: ConceptRecord[],
  claims: ConceptRecord[],
  cap: number,
  degreeOf: (record: ConceptRecord) => number,
): { selected: ConceptRecord[]; truncated: boolean } {
  const total = overview.length + claims.length;
  if (!Number.isFinite(cap) || total <= cap) {
    return { selected: [...overview, ...claims], truncated: false };
  }

  const papers = overview.filter((record) => record.type === "Paper");
  const hubs = overview.filter((record) => record.type !== "Paper");

  const keptPapers = papers.length <= cap
    ? papers
    : [...papers].sort((left, right) => degreeOf(right) - degreeOf(left) || left.id.localeCompare(right.id)).slice(0, cap);

  if (keptPapers.length >= cap) {
    return { selected: keptPapers, truncated: true };
  }

  const paperIds = new Set(keptPapers.map((record) => record.id));
  const fromPapers = new Set<string>();
  for (const paper of keptPapers) {
    for (const target of paper.outgoing) {
      fromPapers.add(target);
    }
  }
  const linked: ConceptRecord[] = [];
  const other: ConceptRecord[] = [];
  for (const hub of hubs) {
    const touchesPaper = fromPapers.has(hub.id) || hub.outgoing.some((target) => paperIds.has(target));
    (touchesPaper ? linked : other).push(hub);
  }
  const byDegree = (left: ConceptRecord, right: ConceptRecord) =>
    degreeOf(right) - degreeOf(left) || left.id.localeCompare(right.id);
  linked.sort(byDegree);
  other.sort(byDegree);

  const hubSlots = cap - keptPapers.length;
  const keptHubs = [...linked, ...other].slice(0, hubSlots);
  const claimSlots = cap - keptPapers.length - keptHubs.length;
  const keptClaims = selectFairClaims(claims, degreeOf, claimSlots);
  return { selected: [...keptPapers, ...keptHubs, ...keptClaims], truncated: true };
}
