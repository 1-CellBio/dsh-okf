import { aggregateHotspots } from "@/lib/hotspot/aggregate";
import { listCoverageGaps } from "@/lib/coverage/gaps";
import { buildCoverageMatrix } from "@/lib/coverage/matrix";
import { inferCoverageScope, looksLikeCoverageQuery } from "@/lib/coverage/scope";
import type { BundleIndex } from "@/lib/index/rebuild";
import { isGraphNode } from "@/lib/index/rebuild";
import { libraryPapers } from "@/lib/library/sort";
import type { SearchHit } from "@/lib/index/search";
import { PASSAGE_LIMIT, scorePassage, selectPassages } from "@/lib/retrieve/passages";
import { retrieve } from "@/lib/retrieve/query";
import type { ChatMode } from "@/lib/agent/types";

const MODE_LINES: Record<ChatMode, string[]> = {
  ask: [],
  compare: [
    "Mode: compare. Contrast claims across the supplied papers only. Label inferences vs quoted claims.",
  ],
  gap: [
    "Mode: gap. Coverage tables describe this local bundle only. Say the bundle has no papers on a topic/year; do not claim the scientific field is empty.",
  ],
  "survey-outline": [
    "Mode: survey-outline. Draft section headings and bullet points for a local-bundle survey. No causal sentence without a Claim id. Do not invent papers.",
  ],
  cite: [
    "Mode: cite. Every literature mention must include a Paper or Claim id from this retrieval set. If the set is missing the fact, say so.",
  ],
};
import type { ConceptRecord } from "@/types/okf";

const PAPER_DIGEST = 800;
const LINK_BODY = 240;
const TITLE_FALLBACK_LIMIT = 40;
export const CONTEXT_CHAR_CAP = 24_000;
const EXTRACT_HIT_LIMIT = 6;
const CLAIM_LIMIT = 8;
const CLAIM_QUOTE = 400;
const GAP_LIMIT = 12;

function excerpt(body: string, limit: number): string {
  return body.replace(/\s+/g, " ").trim().slice(0, limit);
}

function latinQuery(text: string): string {
  return (text.match(/[A-Za-z][A-Za-z0-9+-]{1,}/g) ?? []).join(" ");
}

function uniqueById(records: ConceptRecord[]): ConceptRecord[] {
  const seen = new Set<string>();
  const out: ConceptRecord[] = [];
  for (const record of records) {
    if (seen.has(record.id)) {
      continue;
    }
    seen.add(record.id);
    out.push(record);
  }
  return out;
}

function searchRecords(
  index: BundleIndex,
  userText: string,
  type?: string,
  vectorHits?: SearchHit[],
): ConceptRecord[] {
  const hits = retrieve(index, { text: userText, stableOnly: true, type, vectorHits });
  const latin = latinQuery(userText);
  const extra = latin ? retrieve(index, { text: latin, stableOnly: true, type, vectorHits }) : [];
  return uniqueById([...hits, ...extra]);
}

function extractForPaper(index: BundleIndex, paperId: string): ConceptRecord | undefined {
  const extractId = index.extractsByPaper.get(paperId);
  return extractId ? index.concepts.get(extractId) : undefined;
}

function paperForExtract(index: BundleIndex, extract: ConceptRecord): ConceptRecord | undefined {
  if (!extract.paper) {
    return undefined;
  }
  const record = index.concepts.get(extract.paper);
  return record?.type === "Paper" ? record : undefined;
}

function formatPaperDigest(record: ConceptRecord): string {
  const published = record.published ? ` published=${record.published}` : "";
  const doi = record.doi ? ` doi=${record.doi}` : "";
  const tags = record.tags.length > 0 ? ` tags=${record.tags.join(",")}` : "";
  const links =
    record.outgoing.length > 0 ? ` links=${record.outgoing.slice(0, 12).join(",")}` : "";
  const body = excerpt(record.body, PAPER_DIGEST);
  return `- ${record.id} ${record.title ?? record.id}${published}${doi}${tags}${links}${
    body ? `\n  ${body}` : ""
  }`;
}

function formatClaim(record: ConceptRecord): string {
  const paper = record.paper ? ` paper=${record.paper}` : "";
  const stance = record.stance ? ` stance=${record.stance}` : "";
  const confidence = record.confidence ? ` confidence=${record.confidence}` : "";
  const quote = excerpt(record.body.replace(/^>\s*/m, ""), CLAIM_QUOTE);
  return `- ${record.id} ${record.title ?? record.id}${paper}${stance}${confidence}${
    quote ? `\n  quote: ${quote}` : ""
  }`;
}

function collectClaims(
  index: BundleIndex,
  userText: string,
  papers: ConceptRecord[],
  vectorHits?: SearchHit[],
): ConceptRecord[] {
  const paperIds = new Set(papers.map((paper) => paper.id));
  const hits = searchRecords(index, userText, "Claim", vectorHits);
  const linked: ConceptRecord[] = [];
  for (const record of index.concepts.values()) {
    if (record.type !== "Claim" || record.status !== "stable") {
      continue;
    }
    if (record.paper && paperIds.has(record.paper)) {
      linked.push(record);
    }
  }
  return uniqueById([...hits, ...linked])
    .filter((record) => record.confidence !== "disputed")
    .slice(0, CLAIM_LIMIT);
}

function formatLinked(record: ConceptRecord): string {
  const body = excerpt(record.body, LINK_BODY);
  return `- ${record.id} [${record.type}] ${record.title ?? record.id}${body ? `\n  ${body}` : ""}`;
}

function linkedFrom(index: BundleIndex, papers: ConceptRecord[]): ConceptRecord[] {
  const seen = new Set(papers.map((paper) => paper.id));
  const out: ConceptRecord[] = [];
  for (const paper of papers) {
    for (const id of paper.outgoing) {
      if (seen.has(id)) {
        continue;
      }
      const record = index.concepts.get(id);
      if (!record || !isGraphNode(record) || record.type === "Claim" || record.status !== "stable") {
        continue;
      }
      seen.add(id);
      out.push(record);
    }
  }
  return out;
}

type SelectedPassage = {
  text: string;
  extractId: string;
  paperId?: string;
};

/** Collapse passages whose normalized text is identical so duplicated extract
 * bodies don't waste context tokens. First (highest-scored) copy wins. */
function dedupePassages(passages: SelectedPassage[]): SelectedPassage[] {
  const seen = new Set<string>();
  const out: SelectedPassage[] = [];
  for (const passage of passages) {
    const key = passage.text.replace(/\s+/g, " ").trim();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(passage);
  }
  return out;
}

function collectPassages(
  index: BundleIndex,
  userText: string,
  vectorHits?: SearchHit[],
): { passages: SelectedPassage[]; papers: ConceptRecord[]; missingPaperExtracts: string[] } {
  const extractHits = searchRecords(index, userText, "TextExtract", vectorHits).slice(0, EXTRACT_HIT_LIMIT);
  const paperHits = searchRecords(index, userText, "Paper", vectorHits);
  const extracts: ConceptRecord[] = [...extractHits];
  for (const paper of paperHits) {
    const bound = extractForPaper(index, paper.id);
    if (bound && !extracts.some((item) => item.id === bound.id)) {
      extracts.push(bound);
    }
  }

  const scored: SelectedPassage[] = [];
  const missingPaperExtracts: string[] = [];
  const papers: ConceptRecord[] = [];
  const seenPaper = new Set<string>();

  const addPaper = (paper: ConceptRecord | undefined): void => {
    if (!paper || seenPaper.has(paper.id)) {
      return;
    }
    seenPaper.add(paper.id);
    papers.push(paper);
  };

  for (const extract of extracts) {
    const paper = paperForExtract(index, extract);
    if (!extract.paper || !paper) {
      missingPaperExtracts.push(extract.id);
    }
    const body = index.search.getBody(extract.id) ?? extract.body;
    for (const text of selectPassages(body, userText, PASSAGE_LIMIT)) {
      scored.push({
        text,
        extractId: extract.id,
        paperId: paper?.id,
      });
    }
  }

  const passages = dedupePassages(
    scored.sort((a, b) => scorePassage(b.text, userText) - scorePassage(a.text, userText)),
  ).slice(0, PASSAGE_LIMIT);

  for (const passage of passages) {
    if (passage.paperId) {
      addPaper(index.concepts.get(passage.paperId));
    }
  }
  for (const paper of paperHits.slice(0, 3)) {
    addPaper(paper);
  }

  return { passages, papers, missingPaperExtracts };
}

function coverageGapLines(index: BundleIndex, userText: string): string[] {
  const matrix = buildCoverageMatrix(index, inferCoverageScope(index, userText));
  const gaps = listCoverageGaps(matrix).slice(0, GAP_LIMIT);
  const header = "## Coverage gaps (this local bundle, not the whole field)";
  if (gaps.length === 0) {
    return [header, "(no coverage gaps in this window)"];
  }
  return [
    header,
    ...gaps.map((gap) => `- ${gap.kind}: ${gap.title}`),
  ];
}

export function buildAgentContext(
  index: BundleIndex,
  userText: string,
  options?: { mode?: ChatMode; vectorHits?: SearchHit[] },
): string {
  const mode = options?.mode ?? "ask";
  const includeGaps = mode === "gap" || looksLikeCoverageQuery(userText);
  const { passages, papers, missingPaperExtracts } = collectPassages(index, userText, options?.vectorHits);
  const claims = collectClaims(index, userText, papers, options?.vectorHits);
  const linked = linkedFrom(index, papers);
  const years = new Set(
    papers.map((paper) => paper.published?.slice(0, 4)).filter((year): year is string => Boolean(year)),
  );
  const hotspots = aggregateHotspots(index).filter((row) => years.size === 0 || years.has(row.year));

  const header = [
    "You are a research assistant over a local OKF knowledge bundle.",
    "Answer only from the passages, claims, and paper digests below. Cite concept ids like `papers/2017-attention` and `claims/...`.",
    "Quotations must come from the supplied passages or claim quotes. Do not invent Paper ids, Claim ids, or citations.",
    "If a passage has an extract id but no Paper id, say the paper page is missing; do not invent one.",
    "For novelty questions: compare claims in the supplied papers only; label inferences vs quoted claims.",
    ...MODE_LINES[mode],
  ];
  if (includeGaps) {
    header.push(
      "Coverage tables describe this local bundle only. Say the bundle has no papers on a topic/year; do not claim the scientific field is empty.",
    );
  }

  const gapLines = includeGaps ? ["", ...coverageGapLines(index, userText)] : [];

  if (passages.length === 0) {
    // The title list is only needed on the no-full-text fallback path, so the
    // O(N) library sort is skipped whenever real passages were retrieved.
    const catalog = libraryPapers(index).filter((record) => record.status === "stable");
    const titleLines =
      catalog.length === 0
        ? ["(this bundle has no Paper concepts yet)"]
        : catalog.slice(0, TITLE_FALLBACK_LIMIT).map((paper) => {
            const published = paper.published ? ` (${paper.published})` : "";
            return `- ${paper.id} ${paper.title ?? paper.id}${published}`;
          });
    return capContext([
      ...header,
      "No full-text hits in extracts for this query. Do not pretend abstracts were fetched.",
      "You may use the title list below (ids and titles only) to ask a follow-up or say evidence is missing.",
      "",
      "## Paper titles in this bundle",
      ...titleLines,
      ...(claims.length > 0 ? ["", "## Claims", ...claims.map(formatClaim)] : []),
      ...gapLines,
    ].join("\n"));
  }

  const passageLines = passages.map((passage, i) => {
    const paper =
      passage.paperId ??
      "(paper page missing; cite the extract id only, do not invent a Paper id)";
    return [
      `### Passage ${i + 1}`,
      `paper: ${paper}`,
      `extract: ${passage.extractId}`,
      passage.text,
    ].join("\n");
  });

  const paperLines =
    papers.length === 0
      ? ["(no Paper pages bound to these extracts)"]
      : papers.map(formatPaperDigest);

  const linkedLines =
    linked.length === 0
      ? ["(no Topic/Method/Entity links from these papers)"]
      : linked.map(formatLinked);

  const hotspotLines =
    hotspots.length === 0
      ? ["(no dated papers in this hit set)"]
      : hotspots.map((row) => {
          const topics = row.topics
            .slice(0, 8)
            .map((topic) => `${topic.title} (${topic.id})×${topic.count}`)
            .join(", ");
          return `- ${row.year}: ${topics}`;
        });

  const missing =
    missingPaperExtracts.length > 0
      ? [
          "",
          "## Extracts without a Paper page",
          ...missingPaperExtracts.map((id) => `- ${id}`),
        ]
      : [];

  return capContext([
    ...header,
    "",
    "## Retrieved passages",
    ...passageLines,
    "",
    "## Paper digests",
    ...paperLines,
    "",
    "## Claims",
    ...(claims.length === 0
      ? ["(no stable claims in this hit set)"]
      : claims.map(formatClaim)),
    "",
    "## Linked concepts",
    ...linkedLines,
    "",
    "## Topic hotspots (relevant years)",
    ...hotspotLines,
    ...gapLines,
    ...missing,
  ].join("\n"));
}

/** Hard backstop so the assembled prompt can never exceed the token budget
 * even if per-section limits drift. */
function capContext(text: string): string {
  if (text.length <= CONTEXT_CHAR_CAP) {
    return text;
  }
  return `${text.slice(0, CONTEXT_CHAR_CAP)}\n... [context truncated at ${CONTEXT_CHAR_CAP} chars]`;
}

export function retrievalCiteIds(
  index: BundleIndex,
  userText: string,
  options?: { vectorHits?: SearchHit[] },
): { paperIds: string[]; claimIds: string[] } {
  const { papers } = collectPassages(index, userText, options?.vectorHits);
  const claims = collectClaims(index, userText, papers, options?.vectorHits);
  return {
    paperIds: papers.map((paper) => paper.id),
    claimIds: claims.map((claim) => claim.id),
  };
}
