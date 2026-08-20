import { listCoverageGaps } from "@/lib/coverage/gaps";
import {
  buildCoverageMatrix,
  yearBound,
  type CoverageMatrix,
  type CoverageScope,
} from "@/lib/coverage/matrix";
import type { BundleIndex } from "@/lib/index/rebuild";
import { toConceptId } from "@/lib/okf/links";
import type { ConceptRecord } from "@/types/okf";

export type SurveyScope = CoverageScope & {
  topics?: string[];
  methods?: string[];
  question?: string;
};

export type SurveyRetrieval = {
  scope: SurveyScope;
  matrix: CoverageMatrix;
  papers: ConceptRecord[];
  undated: ConceptRecord[];
  claims: ConceptRecord[];
  reviewedClaims: ConceptRecord[];
  extractedClaims: ConceptRecord[];
  methods: ConceptRecord[];
  allowedIds: Set<string>;
  yearBuckets: YearPaperBucket[];
  oversized: boolean;
};

export const SURVEY_DIGEST_CAP = 200;
export const SURVEY_DIGESTS_PER_YEAR = 6;
export const SURVEY_CLAIM_PROMPT_CAP = 24;

export type YearPaperBucket = {
  year: string;
  featured: ConceptRecord[];
  listed: ConceptRecord[];
};

export function bucketPapersByYear(
  papers: ConceptRecord[],
  options?: { digestCap?: number; perYear?: number },
): { buckets: YearPaperBucket[]; oversized: boolean } {
  const digestCap = options?.digestCap ?? SURVEY_DIGEST_CAP;
  const perYear = options?.perYear ?? SURVEY_DIGESTS_PER_YEAR;
  const oversized = papers.length > digestCap;
  const byYear = new Map<string, ConceptRecord[]>();
  for (const paper of papers) {
    const year = paper.published?.slice(0, 4) || "undated";
    const list = byYear.get(year) ?? [];
    list.push(paper);
    byYear.set(year, list);
  }
  const years = [...byYear.keys()].sort();
  const buckets: YearPaperBucket[] = years.map((year) => {
    const group = byYear.get(year) ?? [];
    if (!oversized) {
      return { year, featured: group, listed: [] };
    }
    const featured = [...group]
      .sort((a, b) => (b.published ?? "").localeCompare(a.published ?? "") || a.id.localeCompare(b.id))
      .slice(0, perYear);
    const featuredIds = new Set(featured.map((paper) => paper.id));
    return { year, featured, listed: group.filter((paper) => !featuredIds.has(paper.id)) };
  });
  return { buckets, oversized };
}

function livePaper(record: ConceptRecord | undefined): record is ConceptRecord {
  return Boolean(record && record.type === "Paper" && record.status !== "deprecated");
}

export function papersInSurveyScope(index: BundleIndex, scope: SurveyScope): {
  dated: ConceptRecord[];
  undated: ConceptRecord[];
} {
  const topicIds = new Set(
    (scope.topics ?? (scope.topic ? [scope.topic] : [])).map((id) => toConceptId(id)),
  );
  const methodIds = new Set((scope.methods ?? []).map((id) => toConceptId(id)));
  const from = yearBound(scope.from);
  const to = yearBound(scope.to);
  const dated: ConceptRecord[] = [];
  const undated: ConceptRecord[] = [];

  for (const record of index.concepts.values()) {
    if (!livePaper(record)) {
      continue;
    }
    if (topicIds.size > 0) {
      const linked = record.outgoing.some((id) => topicIds.has(id));
      const back = [...index.concepts.values()].some(
        (concept) => topicIds.has(concept.id) && concept.outgoing.includes(record.id),
      );
      if (!linked && !back) {
        continue;
      }
    }
    if (methodIds.size > 0) {
      const linked = record.outgoing.some((id) => methodIds.has(id));
      if (!linked) {
        continue;
      }
    }
    const year = yearBound(record.published);
    if (!year) {
      undated.push(record);
      continue;
    }
    if (from && year < from) {
      continue;
    }
    if (to && year > to) {
      continue;
    }
    dated.push(record);
  }

  dated.sort((a, b) => (a.published ?? "").localeCompare(b.published ?? "") || a.id.localeCompare(b.id));
  undated.sort((a, b) => a.id.localeCompare(b.id));
  return { dated, undated };
}

export function buildSurveyRetrieval(index: BundleIndex, scope: SurveyScope): SurveyRetrieval {
  const topic = scope.topics?.[0] ?? scope.topic;
  const matrix = buildCoverageMatrix(index, {
    topic,
    from: scope.from,
    to: scope.to,
  });
  const { dated, undated } = papersInSurveyScope(index, scope);
  const { buckets: yearBuckets, oversized } = bucketPapersByYear(dated);
  const paperIds = new Set(dated.map((paper) => paper.id));
  const featuredIds = new Set(yearBuckets.flatMap((bucket) => bucket.featured.map((paper) => paper.id)));
  const claims = [...index.concepts.values()]
    .filter((record) => record.type === "Claim" && record.paper && paperIds.has(record.paper))
    .sort((a, b) => a.id.localeCompare(b.id));
  const promptClaims = oversized
    ? claims.filter((record) => record.paper && featuredIds.has(record.paper))
    : claims;
  const reviewedClaims = promptClaims
    .filter((record) => record.confidence === "reviewed" || record.verifiedHuman)
    .slice(0, SURVEY_CLAIM_PROMPT_CAP);
  const extractedClaims = promptClaims
    .filter((record) => !reviewedClaims.includes(record))
    .slice(0, SURVEY_CLAIM_PROMPT_CAP);
  const methods = [...index.concepts.values()]
    .filter((record) => record.type === "Method" && record.status !== "deprecated")
    .filter((record) => dated.some((paper) => paper.outgoing.includes(record.id) || record.outgoing.includes(paper.id)))
    .sort((a, b) => a.id.localeCompare(b.id));
  const allowedIds = new Set<string>([
    ...dated.map((paper) => paper.id),
    ...undated.map((paper) => paper.id),
    ...claims.map((claim) => claim.id),
  ]);
  return {
    scope,
    matrix,
    papers: dated,
    undated,
    claims,
    reviewedClaims,
    extractedClaims,
    methods,
    allowedIds,
    yearBuckets,
    oversized,
  };
}

export function coverageAppendixMarkdown(retrieval: SurveyRetrieval): string {
  const gaps = listCoverageGaps(retrieval.matrix);
  const missingYears = [...new Set(retrieval.matrix.topics.flatMap((row) => row.missingYears))].sort();
  const lines = [
    "## Coverage appendix",
    "",
    "This appendix describes **this local OKF bundle**, not the whole scientific field.",
    "",
    `- Papers in scope (dated): ${retrieval.papers.length}`,
    `- Undated papers (not on the timeline): ${retrieval.undated.length}`,
    `- Claims in scope: ${retrieval.claims.length} (${retrieval.claims.filter((claim) => claim.confidence === "reviewed" || claim.verifiedHuman).length} reviewed)`,
    missingYears.length > 0 ? `- Missing years: ${missingYears.join(", ")}` : "- Missing years: none in this window",
    "",
    "### In-scope papers",
    "",
    ...(retrieval.papers.length > 0
      ? retrieval.papers.map(
          (paper) => `- [${paper.title ?? paper.id}](/${paper.path}) \`${paper.id}\``,
        )
      : ["- None"]),
    "",
    "### Undated (excluded from timeline)",
    "",
    ...(retrieval.undated.length > 0
      ? retrieval.undated.map((paper) => `- [${paper.title ?? paper.id}](/${paper.path})`)
      : ["- None"]),
  ];
  if (gaps.length > 0) {
    lines.push("", "### Gaps", "", ...gaps.slice(0, 40).map((gap) => `- ${gap.kind}: ${gap.title}`));
  }
  return lines.join("\n");
}
