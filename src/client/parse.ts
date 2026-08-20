/** Frozen tool-call payload the keyed toolview actually reads. */
export type KgToolBlock = {
  callId: string;
  argsRaw?: string;
  kind?: string;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  error?: { name?: string; code?: string };
  call?: { argsRaw?: string };
};

export type ToolLifecycle = "running" | "ok" | "error" | "stopped";

export type SearchHit = {
  id: string;
  type: string;
  title: string;
  path: string;
  published?: string;
};

export type CoverageTopic = {
  id: string;
  title: string;
  paperCount: number;
  missingYears: string[];
  counts: number[];
};

export type CoverageGap = {
  id: string;
  kind: string;
  title: string;
  topicId?: string;
  year?: string;
};

export type SearchView = {
  state: ToolLifecycle;
  query: string;
  type?: string;
  hits: SearchHit[];
  errorSummary: string | null;
};

export type CoverageView = {
  state: ToolLifecycle;
  topic?: string;
  from?: string;
  to?: string;
  years: string[];
  topics: CoverageTopic[];
  gaps: CoverageGap[];
  errorSummary: string | null;
};

export function lifecycleOf(block: KgToolBlock): ToolLifecycle {
  if (block.kind !== "tool-result") {
    return "running";
  }
  if (block.error?.code === "interrupted") {
    return "stopped";
  }
  return block.isError ? "error" : "ok";
}

export function argsRawOf(block: KgToolBlock): string {
  return (block.kind === "tool-result" ? block.call?.argsRaw : block.argsRaw) ?? "";
}

export function resultTextOf(block: KgToolBlock): string | null {
  if (block.kind !== "tool-result") {
    return null;
  }
  const parts: string[] = [];
  for (const item of block.content ?? []) {
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  if (parts.length === 0 && block.error !== undefined) {
    parts.push(`${block.error.name ?? "Error"}: ${block.error.code ?? "failed"}`);
  }
  return parts.join("\n") || null;
}

export function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

export function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

export function parseSearchView(block: KgToolBlock): SearchView {
  const state = lifecycleOf(block);
  const args = parseObject(argsRawOf(block)) ?? {};
  const query = asString(args.query) ?? "";
  const type = asString(args.type);
  const output = resultTextOf(block);
  const body = output ? parseObject(output) : null;
  const hits = Array.isArray(body?.hits) ? body.hits.flatMap(asSearchHit) : [];
  return {
    state,
    query,
    ...(type ? { type } : {}),
    hits,
    errorSummary: state === "error" && output !== null ? firstLine(output) : null,
  };
}

export function parseCoverageView(block: KgToolBlock): CoverageView {
  const state = lifecycleOf(block);
  const args = parseObject(argsRawOf(block)) ?? {};
  const output = resultTextOf(block);
  const body = output ? parseObject(output) : null;
  const years = asStringArray(body?.years);
  const topics = Array.isArray(body?.topics) ? body.topics.flatMap((item) => asCoverageTopic(item, years.length)) : [];
  const gaps = Array.isArray(body?.gaps) ? body.gaps.flatMap(asCoverageGap) : [];
  return {
    state,
    topic: asString(args.topic) ?? asString((body?.scope as Record<string, unknown> | undefined)?.topic),
    from: asString(args.from),
    to: asString(args.to),
    years,
    topics,
    gaps,
    errorSummary: state === "error" && output !== null ? firstLine(output) : null,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function asSearchHit(value: unknown): SearchHit[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const id = asString(record.id);
  const type = asString(record.type);
  const title = asString(record.title);
  const path = asString(record.path);
  if (!id || !type || !title || !path) {
    return [];
  }
  const published = asString(record.published);
  return [{ id, type, title, path, ...(published ? { published } : {}) }];
}

function asCoverageTopic(value: unknown, yearCount: number): CoverageTopic[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const id = asString(record.id);
  const title = asString(record.title);
  if (!id || !title) {
    return [];
  }
  const paperCount = typeof record.paperCount === "number" ? record.paperCount : 0;
  const missingYears = asStringArray(record.missingYears);
  const counts = Array.isArray(record.counts)
    ? record.counts.map((item) => (typeof item === "number" && Number.isFinite(item) ? item : 0))
    : [];
  while (counts.length < yearCount) {
    counts.push(0);
  }
  return [{ id, title, paperCount, missingYears, counts: counts.slice(0, yearCount || counts.length) }];
}

function asCoverageGap(value: unknown): CoverageGap[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const id = asString(record.id);
  const kind = asString(record.kind);
  const title = asString(record.title);
  if (!id || !kind || !title) {
    return [];
  }
  return [{
    id,
    kind,
    title,
    topicId: asString(record.topicId),
    year: asString(record.year),
  }];
}
