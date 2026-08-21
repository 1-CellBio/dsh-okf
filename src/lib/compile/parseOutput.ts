import type { CompileClaim, CompileConcept, CompileOutput, CompilePaper, CompileSegmentOutput } from "./types";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === "string");
}

function parseConcept(value: unknown, label: string): CompileConcept {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  const rec = value as Record<string, unknown>;
  const title = asString(rec.title)?.trim();
  const body = asString(rec.body);
  if (!title) {
    throw new Error(`${label}.title is required`);
  }
  if (body == null) {
    throw new Error(`${label}.body is required`);
  }
  return { title, body, tags: asStringArray(rec.tags) };
}

function parsePaper(value: unknown): CompilePaper {
  if (!value || typeof value !== "object") {
    throw new Error("paper must be an object");
  }
  const rec = value as Record<string, unknown>;
  const title = asString(rec.title)?.trim();
  const body = asString(rec.body);
  if (!title) {
    throw new Error("paper.title is required");
  }
  if (body == null) {
    throw new Error("paper.body is required");
  }
  return {
    title,
    body,
    published: asString(rec.published),
    doi: asString(rec.doi),
    authors: asStringArray(rec.authors),
    venue: asString(rec.venue),
    description: asString(rec.description),
    tags: asStringArray(rec.tags),
  };
}

function parseList(value: unknown, label: string): CompileConcept[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((item, i) => parseConcept(item, `${label}[${i}]`));
}

function parseClaim(value: unknown, label: string): CompileClaim {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  const rec = value as Record<string, unknown>;
  const title = asString(rec.title)?.trim();
  const quote = asString(rec.quote)?.trim();
  if (!title) {
    throw new Error(`${label}.title is required`);
  }
  if (!quote) {
    throw new Error(`${label}.quote is required`);
  }
  return {
    title,
    quote,
    stance: asString(rec.stance),
    body: asString(rec.body),
  };
}

function parseClaimList(value: unknown, label: string): CompileClaim[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((item, i) => parseClaim(item, `${label}[${i}]`));
}

export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("no JSON object found");
  }
  return JSON.parse(candidate.slice(start, end + 1)) as unknown;
}

export function parseCompileOutput(text: string): CompileOutput {
  const raw = extractJsonObject(text);
  if (!raw || typeof raw !== "object") {
    throw new Error("compile output must be an object");
  }
  const rec = raw as Record<string, unknown>;
  return {
    paper: parsePaper(rec.paper),
    topics: parseList(rec.topics, "topics"),
    methods: parseList(rec.methods, "methods"),
    entities: parseList(rec.entities, "entities"),
    datasets: parseList(rec.datasets, "datasets"),
    genes: parseList(rec.genes, "genes"),
    pathways: parseList(rec.pathways, "pathways"),
    claims: parseClaimList(rec.claims, "claims"),
  };
}

export function parseClaimsOnly(text: string): CompileClaim[] {
  const raw = extractJsonObject(text);
  if (!raw || typeof raw !== "object") {
    throw new Error("claims output must be an object");
  }
  return parseClaimList((raw as Record<string, unknown>).claims, "claims");
}

export function parseSegmentOutput(text: string): CompileSegmentOutput {
  const raw = extractJsonObject(text);
  if (!raw || typeof raw !== "object") {
    throw new Error("compile segment output must be an object");
  }
  const rec = raw as Record<string, unknown>;
  const paper = rec.paper && typeof rec.paper === "object" ? (rec.paper as Record<string, unknown>) : undefined;
  return {
    additions: asString(rec.additions) ?? asString(paper?.body),
    topics: parseList(rec.topics, "topics"),
    methods: parseList(rec.methods, "methods"),
    entities: parseList(rec.entities, "entities"),
    datasets: parseList(rec.datasets, "datasets"),
    genes: parseList(rec.genes, "genes"),
    pathways: parseList(rec.pathways, "pathways"),
    claims: parseClaimList(rec.claims, "claims"),
  };
}
