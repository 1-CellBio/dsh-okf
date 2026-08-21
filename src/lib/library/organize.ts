import { pruneUnquotedClaims } from "@/lib/compile/pruneClaims";
import { excerptBody } from "@/lib/graph/neighbors";
import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { isIndexableMarkdown, parseConceptRecord } from "@/lib/index/catalog";
import { stampEquals, stampPaths, type FileStamp } from "@/lib/index/stamps";
import { resetWorkbenchCache } from "@/lib/library/workbench";
import { isOkfCachePath } from "@/lib/okf/cache";
import { asString } from "@/lib/okf/identity";
import { conceptPath, toConceptId } from "@/lib/okf/links";
import { parseDocument } from "@/lib/okf/parse";
import {
  buildReviewQueue,
  packReviewQueue,
  type PackedReview,
} from "@/lib/review/queue";

export type OrganizeCard = {
  id: string;
  path: string;
  title: string;
  status: string;
  excerpt: string;
  links: string[];
};

export type OrganizeSnapshot = {
  review: PackedReview;
  notes: OrganizeCard[];
  questions: OrganizeCard[];
  surveys: OrganizeCard[];
  manuscripts: string[];
};

type OrganizeCache = {
  root: string | undefined;
  stamps: Map<string, FileStamp>;
  snapshot: OrganizeSnapshot;
};

/** Single-slot memo, mirroring the workbench snapshot cache: an unchanged
 * library reuses the last snapshot instead of re-reading and re-parsing every
 * concept file and extract (the review queue reads the whole library). */
let organizeCache: OrganizeCache | null = null;

/** Clear the memoized snapshot cache. Exported for tests. */
export function resetOrganizeCache(): void {
  organizeCache = null;
}

/**
 * Durable organize surfaces for the session UI: review queue plus Note / Question / Survey
 * cards. Does not dump paper bodies. persist:false so a GET does not rewrite the cache.
 */
export async function organizeWorkbench(store: FileStore): Promise<OrganizeSnapshot> {
  const listed = (await store.list("")).filter((path) => path.endsWith(".md") || path.endsWith(".bib") || path.endsWith(".tex"));

  // Stamp every input the snapshot derives from (notes/questions/surveys,
  // manuscripts, all concepts, and the extracts the review queue reads).
  const stampValues = await stampPaths(store, listed);
  const stamps = new Map<string, FileStamp>();
  listed.forEach((path, index) => {
    stamps.set(path, stampValues[index]!);
  });
  const cached = organizeCache;
  if (
    cached
    && cached.root === store.root
    && cached.stamps.size === stamps.size
    && [...stamps.entries()].every(([path, stamp]) => {
      const old = cached.stamps.get(path);
      return old !== undefined && stampEquals(old, stamp);
    })
  ) {
    return cached.snapshot;
  }

  const prune = await pruneUnquotedClaims(store);
  let stampMap = stamps;
  let paths = listed;
  if (prune.pruned > 0 || prune.healed > 0) {
    resetWorkbenchCache();
    paths = (await store.list("")).filter((path) => path.endsWith(".md") || path.endsWith(".bib") || path.endsWith(".tex"));
    const nextStamps = await stampPaths(store, paths);
    stampMap = new Map<string, FileStamp>();
    paths.forEach((path, index) => {
      stampMap.set(path, nextStamps[index]!);
    });
  }

  const notes: OrganizeCard[] = [];
  const questions: OrganizeCard[] = [];
  const surveys: OrganizeCard[] = [];
  const manuscripts: string[] = [];

  for (const path of paths) {
    if (path.startsWith("manuscripts/") && !isOkfCachePath(path)) {
      manuscripts.push(path);
      continue;
    }
    if (!isIndexableMarkdown(path)) {
      continue;
    }
    if (path.startsWith("notes/")) {
      const card = await cardOf(store, path, "Note");
      if (card) {
        notes.push(card);
      }
    } else if (path.startsWith("questions/")) {
      const card = await cardOf(store, path, "Question");
      if (card) {
        questions.push(card);
      }
    } else if (path.startsWith("surveys/")) {
      const card = await cardOf(store, path, "Survey");
      if (card) {
        surveys.push(card);
      }
    }
  }

  const byTitle = (left: OrganizeCard, right: OrganizeCard): number =>
    left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
  notes.sort(byTitle);
  questions.sort(byTitle);
  surveys.sort(byTitle);
  manuscripts.sort();

  const items = await buildReviewQueue(store, { persist: false });

  const snapshot: OrganizeSnapshot = {
    review: packReviewQueue(items),
    notes,
    questions,
    surveys,
    manuscripts,
  };
  organizeCache = { root: store.root, stamps: stampMap, snapshot };
  return snapshot;
}

export type WorkbenchPage = {
  id: string;
  path: string;
  type?: string;
  title?: string;
  status?: string;
  body: string;
  truncated: boolean;
  outgoing: string[];
};

const PAGE_BODY_CAP = 80_000;

/** Read one concept page or a manuscripts/ export. Browser never opens the OKF folder. */
export async function readWorkbenchPage(store: FileStore, id: string): Promise<WorkbenchPage> {
  const trimmed = id.trim().replace(/^\/+/, "");
  if (!trimmed) {
    throw new Error("page id is required");
  }
  if (trimmed.startsWith("sources/") || isOkfCachePath(trimmed) || trimmed.includes("..")) {
    throw new Error("page does not serve PDFs or cache files");
  }
  if (trimmed.startsWith("manuscripts/")) {
    if (!(await store.exists(trimmed))) {
      throw new Error(`File not found: ${trimmed}`);
    }
    let body = utf8Decode(await store.read(trimmed));
    let truncated = false;
    if (body.length > PAGE_BODY_CAP) {
      body = `${body.slice(0, PAGE_BODY_CAP)}\n\n… truncated`;
      truncated = true;
    }
    return {
      id: trimmed,
      path: trimmed,
      type: "Manuscript",
      title: trimmed.replace(/^manuscripts\//, ""),
      body,
      truncated,
      outgoing: [],
    };
  }
  const pathKey = conceptPath(trimmed);
  if (!(await store.exists(pathKey))) {
    throw new Error(`Concept not found: ${toConceptId(trimmed)}`);
  }
  const raw = utf8Decode(await store.read(pathKey));
  const doc = parseDocument(raw);
  const type = asString(doc.frontmatter.type);
  let body = doc.body;
  let truncated = false;
  if (body.length > PAGE_BODY_CAP) {
    body = `${body.slice(0, PAGE_BODY_CAP)}\n\n… truncated`;
    truncated = true;
  }
  const record = parseConceptRecord(pathKey, raw);
  return {
    id: toConceptId(pathKey),
    path: pathKey,
    type,
    title: asString(doc.frontmatter.title),
    status: asString(doc.frontmatter.status),
    body,
    truncated,
    outgoing: record?.outgoing.slice(0, 24) ?? [],
  };
}

async function cardOf(store: FileStore, path: string, type: string): Promise<OrganizeCard | undefined> {
  const record = parseConceptRecord(path, utf8Decode(await store.read(path)));
  if (!record || record.type !== type) {
    return undefined;
  }
  return {
    id: record.id,
    path: record.path,
    title: record.title ?? record.id,
    status: record.status,
    excerpt: excerptBody(record.body, 220),
    links: record.outgoing.slice(0, 12),
  };
}
