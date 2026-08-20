import type { ConceptRecord } from "@/types/okf";

/**
 * Fairly distribute `slots` claim records across their owning papers so that a
 * node cap cannot let one paper's claims monopolize the graph. Each paper's
 * claims are ordered by link count (undirected degree) descending, then by id
 * for determinism, and selection round-robins across papers: every paper with
 * claims contributes its best (highest-degree) claim before any paper takes a
 * second one. Claims without a `paper` field are grouped under their own id so
 * they still get a share instead of being dropped.
 */
export function selectFairClaims(
  claims: ConceptRecord[],
  degreeOf: (record: ConceptRecord) => number,
  slots: number,
): ConceptRecord[] {
  if (slots <= 0 || claims.length === 0) {
    return [];
  }
  const groups = new Map<string, ConceptRecord[]>();
  for (const claim of claims) {
    const key = claim.paper ?? `__claim:${claim.id}`;
    const list = groups.get(key);
    if (list) {
      list.push(claim);
    } else {
      groups.set(key, [claim]);
    }
  }
  for (const list of groups.values()) {
    list.sort((a, b) => degreeOf(b) - degreeOf(a) || a.id.localeCompare(b.id));
  }
  const queues = [...groups.values()];
  const selected: ConceptRecord[] = [];
  let any = true;
  while (selected.length < slots && any) {
    any = false;
    for (const queue of queues) {
      if (selected.length >= slots) {
        break;
      }
      const next = queue.shift();
      if (next) {
        selected.push(next);
        any = true;
      }
    }
  }
  return selected;
}
