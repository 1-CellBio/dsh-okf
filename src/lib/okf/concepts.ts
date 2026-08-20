/**
 * Canonical concept types in the OKF knowledge library.
 *
 * Single source of truth for the concept type list, its directory prefix,
 * graph-node membership, default visibility, display ordering, and Chinese
 * labels — so adding or removing a concept type touches one file instead of
 * the ~20 scattered literals that used to enumerate the types.
 */

export const CONCEPT_TYPES = [
  "Paper",
  "Claim",
  "Topic",
  "Method",
  "Entity",
  "Dataset",
  "Gene",
  "Pathway",
] as const;

export type ConceptType = (typeof CONCEPT_TYPES)[number];

/** Directory prefix for each concept type (plural, lowercase). */
export const CONCEPT_DIRS: Record<ConceptType, string> = {
  Paper: "papers/",
  Claim: "claims/",
  Topic: "topics/",
  Method: "methods/",
  Entity: "entities/",
  Dataset: "datasets/",
  Gene: "genes/",
  Pathway: "pathways/",
};

/** Types rendered as nodes in the library graph. */
export const GRAPH_NODE_TYPES: readonly string[] = CONCEPT_TYPES;

/**
 * Types visible in the graph by default. Dataset is on; Gene and Pathway are
 * opt-in (they can be numerous, so they default to hidden to keep the graph
 * readable).
 */
export const DEFAULT_GRAPH_TYPES: readonly string[] = [
  "Paper",
  "Topic",
  "Method",
  "Entity",
  "Dataset",
];

/** Canonical sort order (smaller first) for grouping/ranking by type. */
export const TYPE_RANK: Record<string, number> = {
  Paper: 0,
  Topic: 1,
  Method: 2,
  Entity: 3,
  Dataset: 4,
  Gene: 5,
  Pathway: 6,
  Claim: 7,
};

export function typeRank(type: string): number {
  return TYPE_RANK[type] ?? 8;
}

/** Chinese labels shared by the graph legend, toggles and inspect sheet. */
export const TYPE_LABELS: Record<string, string> = {
  Paper: "论文",
  Topic: "主题",
  Method: "方法",
  Entity: "实体",
  Dataset: "数据集",
  Gene: "基因",
  Pathway: "通路",
  Claim: "主张",
};
