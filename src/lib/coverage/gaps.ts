import type { CoverageMatrix, CoverageRef, TopicCoverageRow } from "./matrix";

export type GapKind =
  | "missing_year"
  | "missing_method"
  | "missing_dataset"
  | "missing_gene"
  | "missing_pathway"
  | "undated_paper";

export type CoverageGap = {
  id: string;
  kind: GapKind;
  title: string;
  detail: string;
  topicId?: string;
  topicTitle?: string;
  hubId?: string;
  hubTitle?: string;
  paperId?: string;
  year?: string;
};

const HUB_SPECS: Array<{ kind: GapKind; label: string; missing: (row: TopicCoverageRow) => CoverageRef[] }> = [
  { kind: "missing_method", label: "Method", missing: (row) => row.missingMethods },
  { kind: "missing_dataset", label: "Dataset", missing: (row) => row.missingDatasets },
  { kind: "missing_gene", label: "Gene", missing: (row) => row.missingGenes },
  { kind: "missing_pathway", label: "Pathway", missing: (row) => row.missingPathways },
];

function topicLabel(row: TopicCoverageRow): string {
  return row.title || row.id;
}

export function listCoverageGaps(matrix: CoverageMatrix): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  const singleTopic = Boolean(matrix.scope.topic) || matrix.topics.length === 1;

  for (const topic of matrix.topics) {
    const hasPapers = topic.paperCount > 0 || topic.undated.length > 0;
    if (!singleTopic && !hasPapers) {
      continue;
    }
    for (const year of topic.missingYears) {
      gaps.push({
        id: `missing_year:${topic.id}:${year}`,
        kind: "missing_year",
        title: `${topicLabel(topic)} has no papers in ${year}`,
        detail: `This local bundle has no Paper linked to ${topic.id} with published in ${year}.`,
        topicId: topic.id,
        topicTitle: topic.title,
        year,
      });
    }
    if (singleTopic) {
      for (const spec of HUB_SPECS) {
        for (const hub of spec.missing(topic)) {
          gaps.push({
            id: `${spec.kind}:${topic.id}:${hub.id}`,
            kind: spec.kind,
            title: `${hub.title} is unused with ${topicLabel(topic)}`,
            detail: `${spec.label} ${hub.id} is used in this bundle but not with ${topic.id} in the selected window.`,
            topicId: topic.id,
            topicTitle: topic.title,
            hubId: hub.id,
            hubTitle: hub.title,
          });
        }
      }
    }
    for (const paper of topic.undated) {
      gaps.push({
        id: `undated_paper:${paper.id}:${topic.id}`,
        kind: "undated_paper",
        title: `${paper.title} is missing published`,
        detail: `${paper.id} is linked to ${topic.id} but has no published date.`,
        topicId: topic.id,
        topicTitle: topic.title,
        paperId: paper.id,
      });
    }
  }

  if (!matrix.scope.topic) {
    const seen = new Set(gaps.filter((gap) => gap.kind === "undated_paper").map((gap) => gap.paperId));
    for (const paper of matrix.undated) {
      if (seen.has(paper.id)) {
        continue;
      }
      gaps.push({
        id: `undated_paper:${paper.id}`,
        kind: "undated_paper",
        title: `${paper.title} is missing published`,
        detail: `${paper.id} has no published date.`,
        paperId: paper.id,
      });
    }
  }

  return gaps.sort((a, b) => a.id.localeCompare(b.id));
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

export function formatCoverageMatrix(matrix: CoverageMatrix): string {
  const topicWidth = Math.max(8, ...matrix.topics.map((topic) => topic.title.length), 8);
  const header = ["Topic".padEnd(topicWidth), ...matrix.years.map((year) => year.padStart(5))].join(" ");
  const rows = matrix.topics.map((topic) => {
    const counts = matrix.years.map((year) => String(topic.years[year]?.count ?? 0).padStart(5));
    return [pad(topic.title, topicWidth), ...counts].join(" ");
  });
  const scope = [
    matrix.scope.topic ? `topic=${matrix.scope.topic}` : "topic=*",
    matrix.scope.from && matrix.scope.to ? `${matrix.scope.from}–${matrix.scope.to}` : "years=auto",
  ].join("  ");
  return [`Coverage ${scope}`, header, ...rows].join("\n");
}

export function formatCoverageGaps(gaps: CoverageGap[]): string {
  if (gaps.length === 0) {
    return "Coverage gaps (0)\n(none)\n";
  }
  const kinds: GapKind[] = [
    "missing_year",
    "missing_method",
    "missing_dataset",
    "missing_gene",
    "missing_pathway",
    "undated_paper",
  ];
  const lines = [`Coverage gaps (${gaps.length})`, ""];
  for (const kind of kinds) {
    const group = gaps.filter((gap) => gap.kind === kind);
    if (group.length === 0) {
      continue;
    }
    lines.push(`${kind} (${group.length})`);
    for (const gap of group) {
      const loc = gap.year ?? gap.hubId ?? gap.paperId ?? "";
      lines.push(`  ${loc}  ${gap.title}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function formatCoverageReport(matrix: CoverageMatrix, gaps: CoverageGap[]): string {
  return `${formatCoverageMatrix(matrix)}\n\n${formatCoverageGaps(gaps)}`;
}
