/**
 * Graph scale for the library overview page.
 *
 * Target: interactive overview of 1000+ compiled PDFs. A paper becomes one
 * Paper node plus shared Topic/Method/Entity/Dataset hubs (claims stay opt-in).
 * 1000 papers typically land in the 2k–8k overview-node range; claims can add
 * tens of thousands and must not be dumped into the first paint.
 */

/** Default `/okf/library` cap when the client omits maxNodes. */
export const GRAPH_OVERVIEW_CAP = 8000;

/** Absolute ceiling for one library snapshot (HTTP + workbench). */
export const GRAPH_HARD_CAP = 20_000;

/** Value shown in the graph-page maxNodes field (same as GRAPH_OVERVIEW_CAP). */
export const GRAPH_DEFAULT_MAX_NODES = GRAPH_OVERVIEW_CAP;
