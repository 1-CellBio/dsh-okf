import { normalizeAlignKey } from "@/lib/compile/align";
import { unionTags } from "@/lib/okf/identity";
import { quoteFingerprint } from "@/lib/okf/quote";
import type { CompileClaim, CompileConcept, CompileOutput, CompileSegmentOutput } from "./types";

function mergeBodies(head: string, extra: string): string {
  const addition = extra.trim();
  if (!addition) {
    return head;
  }
  if (head.includes(addition)) {
    return head;
  }
  return `${head.trimEnd()}\n\n${addition}`;
}

function mergeConceptLists(head: CompileConcept[], more: CompileConcept[]): CompileConcept[] {
  const byKey = new Map<string, CompileConcept>();
  const order: string[] = [];
  for (const item of [...head, ...more]) {
    const key = normalizeAlignKey(item.title) || item.title.trim().toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...item });
      order.push(key);
      continue;
    }
    byKey.set(key, {
      ...existing,
      tags: unionTags(existing.tags, item.tags),
      body: mergeBodies(existing.body, item.body),
    });
  }
  return order.map((key) => byKey.get(key)!);
}

function mergeClaimLists(head: CompileClaim[], more: CompileClaim[]): CompileClaim[] {
  const seen = new Set<string>();
  const out: CompileClaim[] = [];
  for (const claim of [...head, ...more]) {
    const finger = quoteFingerprint(claim.quote).trim();
    const key = finger || claim.title.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(claim);
  }
  return out;
}

export function knownTitlesOf(output: CompileOutput): string {
  const titles = [
    ...output.topics,
    ...output.methods,
    ...output.entities,
    ...output.datasets,
    ...output.genes,
    ...output.pathways,
  ].map((item) => item.title.trim());
  return [...new Set(titles.filter(Boolean))].join(", ");
}

/** Fold continuation passes into the head compile so later PDF pages are not dropped. */
export function mergeCompileOutput(head: CompileOutput, tails: CompileSegmentOutput[]): CompileOutput {
  let paperBody = head.paper.body;
  let topics = head.topics;
  let methods = head.methods;
  let entities = head.entities;
  let datasets = head.datasets;
  let genes = head.genes;
  let pathways = head.pathways;
  let claims = head.claims;
  for (const tail of tails) {
    topics = mergeConceptLists(topics, tail.topics);
    methods = mergeConceptLists(methods, tail.methods);
    entities = mergeConceptLists(entities, tail.entities);
    datasets = mergeConceptLists(datasets, tail.datasets);
    genes = mergeConceptLists(genes, tail.genes);
    pathways = mergeConceptLists(pathways, tail.pathways);
    claims = mergeClaimLists(claims, tail.claims);
    if (tail.additions?.trim()) {
      paperBody = mergeBodies(paperBody, tail.additions);
    }
  }
  return {
    paper: { ...head.paper, body: paperBody },
    topics,
    methods,
    entities,
    datasets,
    genes,
    pathways,
    claims,
  };
}
