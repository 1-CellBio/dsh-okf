import { aggregateHotspots, type YearHotspot } from "@/lib/hotspot/aggregate";
import type { BundleIndex } from "@/lib/index/rebuild";
import { toConceptId } from "@/lib/okf/links";
import { publishedYear } from "@/lib/okf/slug";
import type { ConceptRecord } from "@/types/okf";

const YEAR_SPAN_CAP = 100;

export type CoverageScope = {
  topic?: string;
  from?: string;
  to?: string;
};

export type CoverageRef = {
  id: string;
  title: string;
};

export type CoverageCell = {
  count: number;
  paperIds: string[];
};

export type TopicCoverageRow = CoverageRef & {
  years: Record<string, CoverageCell>;
  missingYears: string[];
  methods: Record<string, CoverageCell>;
  missingMethods: CoverageRef[];
  datasets: Record<string, CoverageCell>;
  missingDatasets: CoverageRef[];
  genes: Record<string, CoverageCell>;
  missingGenes: CoverageRef[];
  pathways: Record<string, CoverageCell>;
  missingPathways: CoverageRef[];
  undated: CoverageRef[];
  paperCount: number;
};

export type CoverageMatrix = {
  scope: { topic?: string; from?: string; to?: string };
  years: string[];
  methods: CoverageRef[];
  datasets: CoverageRef[];
  genes: CoverageRef[];
  pathways: CoverageRef[];
  topics: TopicCoverageRow[];
  undated: CoverageRef[];
  hotspots: YearHotspot[];
};

/** Hub types tracked against papers alongside Topic (Datasets/Genes/Pathways are first-class). */
export const HUB_TYPES = ["Topic", "Method", "Dataset", "Gene", "Pathway"] as const;
export type HubType = (typeof HUB_TYPES)[number];
type HubKey = "topics" | "methods" | "datasets" | "genes" | "pathways";
const HUB_KEY: Record<HubType, HubKey> = {
  Topic: "topics",
  Method: "methods",
  Dataset: "datasets",
  Gene: "genes",
  Pathway: "pathways",
};
const HUB_TYPE_OF: Record<HubKey, HubType> = {
  topics: "Topic",
  methods: "Method",
  datasets: "Dataset",
  genes: "Gene",
  pathways: "Pathway",
};

/** Hub dimensions tracked per topic row (Topic itself filters the papers). */
const CELL_KEYS: HubKey[] = ["methods", "datasets", "genes", "pathways"];
type CellKey = (typeof CELL_KEYS)[number];

function live<T extends string>(record: ConceptRecord | undefined, type: T): record is ConceptRecord & { type: T } {
  if (!record || record.status === "deprecated") {
    return false;
  }
  return record.type === type;
}

function asRef(record: ConceptRecord): CoverageRef {
  return { id: record.id, title: record.title ?? record.id };
}

export function yearBound(value?: string): string | undefined {
  const raw = value?.trim();
  if (!raw) {
    return undefined;
  }
  return publishedYear(raw);
}

export function enumerateYears(from: string, to: string): string[] {
  let start = Number(from);
  let end = Number(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return [];
  }
  if (start > end) {
    [start, end] = [end, start];
  }
  if (end - start > YEAR_SPAN_CAP) {
    end = start + YEAR_SPAN_CAP;
  }
  const years: string[] = [];
  for (let year = start; year <= end; year++) {
    years.push(String(year));
  }
  return years;
}

function emptyCell(): CoverageCell {
  return { count: 0, paperIds: [] };
}

function addPaper(cell: CoverageCell, paperId: string): void {
  if (cell.paperIds.includes(paperId)) {
    return;
  }
  cell.paperIds.push(paperId);
  cell.count = cell.paperIds.length;
}

function addPaperToHubCells(
  adjacency: Record<HubKey, Map<string, Set<string>>>,
  hubKey: HubKey,
  cells: Record<string, CoverageCell>,
  paperId: string,
): void {
  for (const hubId of adjacency[hubKey].get(paperId) ?? []) {
    cells[hubId] ??= emptyCell();
    addPaper(cells[hubId]!, paperId);
  }
}

function buildAdjacency(index: BundleIndex): Record<HubKey, Map<string, Set<string>>> {
  const adjacency = Object.fromEntries(HUB_TYPES.map((type) => [HUB_KEY[type], new Map<string, Set<string>>()])) as Record<
    HubKey,
    Map<string, Set<string>>
  >;
  const add = (map: Map<string, Set<string>>, paperId: string, otherId: string): void => {
    const set = map.get(paperId) ?? new Set<string>();
    set.add(otherId);
    map.set(paperId, set);
  };

  for (const record of index.concepts.values()) {
    if (!live(record, "Paper")) {
      continue;
    }
    for (const id of record.outgoing) {
      const target = index.concepts.get(id);
      if (!target) {
        continue;
      }
      for (const type of HUB_TYPES) {
        if (live(target, type)) {
          add(adjacency[HUB_KEY[type]], record.id, target.id);
          break;
        }
      }
    }
  }

  for (const record of index.concepts.values()) {
    if (record.status === "deprecated") {
      continue;
    }
    const hubType = HUB_TYPES.find((type) => record.type === type);
    if (!hubType) {
      continue;
    }
    for (const id of record.outgoing) {
      const paper = index.concepts.get(id);
      if (!live(paper, "Paper")) {
        continue;
      }
      add(adjacency[HUB_KEY[hubType]], paper.id, record.id);
    }
  }

  return adjacency;
}

function defaultYearSpan(index: BundleIndex): { from?: string; to?: string } {
  const years: string[] = [];
  for (const record of index.concepts.values()) {
    if (!live(record, "Paper")) {
      continue;
    }
    const year = yearBound(record.published);
    if (!year) {
      continue;
    }
    years.push(year);
  }
  if (years.length === 0) {
    return {};
  }
  years.sort();
  return { from: years[0], to: years[years.length - 1] };
}

export function buildCoverageMatrix(index: BundleIndex, scope: CoverageScope = {}): CoverageMatrix {
  const topicId = scope.topic ? toConceptId(scope.topic) : undefined;
  const inferred = defaultYearSpan(index);
  const from = yearBound(scope.from) ?? inferred.from;
  const to = yearBound(scope.to) ?? inferred.to;
  const years = from && to ? enumerateYears(from, to) : [];
  const adjacency = buildAdjacency(index);
  const paperTopics = adjacency.topics;

  const catalog = {} as Record<CellKey, CoverageRef[]>;
  for (const key of CELL_KEYS) {
    const type = HUB_TYPE_OF[key];
    const usedByPapers = adjacency[key];
    catalog[key] = [...index.concepts.values()]
      .filter((record) => live(record, type))
      .filter((record) => [...usedByPapers.values()].some((set) => set.has(record.id)))
      .map(asRef)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  const topicRecords = [...index.concepts.values()]
    .filter((record) => live(record, "Topic"))
    .sort((a, b) => a.id.localeCompare(b.id));

  const selectedTopics = topicId
    ? topicRecords.filter((record) => record.id === topicId)
    : topicRecords.filter((record) => {
        for (const topics of paperTopics.values()) {
          if (topics.has(record.id)) {
            return true;
          }
        }
        return false;
      });

  const topics: TopicCoverageRow[] = [];
  const undatedAll: CoverageRef[] = [];
  const seenUndated = new Set<string>();

  const papers = [...index.concepts.values()].filter((record) => live(record, "Paper"));

  for (const topic of selectedTopics) {
    const yearCells: Record<string, CoverageCell> = {};
    for (const year of years) {
      yearCells[year] = emptyCell();
    }
    const hubCells = {} as Record<CellKey, Record<string, CoverageCell>>;
    for (const key of CELL_KEYS) {
      hubCells[key] = {};
    }
    const undated: CoverageRef[] = [];
    let paperCount = 0;

    for (const paper of papers) {
      if (!paperTopics.get(paper.id)?.has(topic.id)) {
        continue;
      }
      const year = yearBound(paper.published);
      if (!year) {
        undated.push(asRef(paper));
        if (!seenUndated.has(paper.id)) {
          seenUndated.add(paper.id);
          undatedAll.push(asRef(paper));
        }
        for (const key of CELL_KEYS) {
          addPaperToHubCells(adjacency, key, hubCells[key], paper.id);
        }
        continue;
      }
      if (from && year < from) {
        continue;
      }
      if (to && year > to) {
        continue;
      }
      paperCount += 1;
      if (yearCells[year]) {
        addPaper(yearCells[year], paper.id);
      }
      for (const key of CELL_KEYS) {
        addPaperToHubCells(adjacency, key, hubCells[key], paper.id);
      }
    }

    const missingYears = years.filter((year) => (yearCells[year]?.count ?? 0) === 0);
    const perTopic = topicId || selectedTopics.length === 1;
    const missing = {} as Record<CellKey, CoverageRef[]>;
    for (const key of CELL_KEYS) {
      const used = new Set(Object.keys(hubCells[key]));
      missing[key] = perTopic ? catalog[key].filter((hub) => !used.has(hub.id)) : [];
    }

    topics.push({
      id: topic.id,
      title: topic.title ?? topic.id,
      years: yearCells,
      missingYears,
      methods: hubCells.methods,
      missingMethods: missing.methods,
      datasets: hubCells.datasets,
      missingDatasets: missing.datasets,
      genes: hubCells.genes,
      missingGenes: missing.genes,
      pathways: hubCells.pathways,
      missingPathways: missing.pathways,
      undated,
      paperCount,
    });
  }

  if (topicId && topics.length === 0) {
    const title = index.concepts.get(topicId)?.title ?? topicId;
    const yearCells: Record<string, CoverageCell> = {};
    for (const year of years) {
      yearCells[year] = emptyCell();
    }
    topics.push({
      id: topicId,
      title,
      years: yearCells,
      missingYears: [...years],
      methods: {},
      missingMethods: catalog.methods,
      datasets: {},
      missingDatasets: catalog.datasets,
      genes: {},
      missingGenes: catalog.genes,
      pathways: {},
      missingPathways: catalog.pathways,
      undated: [],
      paperCount: 0,
    });
  }

  const yearSet = new Set(years);
  const hotspots = aggregateHotspots(index).filter((row) => yearSet.size === 0 || yearSet.has(row.year));

  if (!topicId) {
    for (const paper of papers) {
      if (yearBound(paper.published) || seenUndated.has(paper.id)) {
        continue;
      }
      seenUndated.add(paper.id);
      undatedAll.push(asRef(paper));
    }
  }

  return {
    scope: { topic: topicId, from, to },
    years,
    methods: catalog.methods,
    datasets: catalog.datasets,
    genes: catalog.genes,
    pathways: catalog.pathways,
    topics,
    undated: undatedAll.sort((a, b) => a.id.localeCompare(b.id)),
    hotspots,
  };
}
