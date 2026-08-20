/**
 * Client-side copies of the canonical concept-type lists. Kept separate from
 * `lib/okf/concepts.ts` because the browser bundle must not pull server modules.
 */
import type { OkfLocaleKey } from "./locales.ts";

export const GRAPH_TYPE_FILTERS = [
  "Paper",
  "Topic",
  "Method",
  "Entity",
  "Dataset",
  "Gene",
  "Pathway",
  "Claim",
] as const;

/** Types visible in the graph by default (Gene/Pathway are opt-in). */
export const DEFAULT_GRAPH_TYPES: string[] = ["Paper", "Topic", "Method", "Entity", "Dataset"];

export const LEGEND = [
  "Paper",
  "Topic",
  "Method",
  "Entity",
  "Dataset",
  "Gene",
  "Pathway",
  "Claim",
] as const;
export type LegendType = (typeof LEGEND)[number];

/** Deterministic type columns for the column layout. */
export const GRAPH_COLUMNS: readonly string[] = [...LEGEND, "unknown"];

/** Canonical neighbor/group sort order. */
export const NODE_TYPE_ORDER: readonly string[] = [...LEGEND];

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

/** Locale key for a node type's label. */
export function legendKey(type: string): OkfLocaleKey {
  if (type === "Paper") return "legend.Paper";
  if (type === "Topic") return "legend.Topic";
  if (type === "Method") return "legend.Method";
  if (type === "Entity") return "legend.Entity";
  if (type === "Dataset") return "legend.Dataset";
  if (type === "Gene") return "legend.Gene";
  if (type === "Pathway") return "legend.Pathway";
  return "legend.Claim";
}

/** Coerce any node type (including ghost "unknown") to a legend type. */
export function asLegend(type: string): LegendType {
  if ((LEGEND as readonly string[]).includes(type)) {
    return type as LegendType;
  }
  return "Entity";
}
