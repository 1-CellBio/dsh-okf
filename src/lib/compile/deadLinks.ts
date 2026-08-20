import { createHash } from "node:crypto";
import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { withPathLock } from "@/lib/fs/pathLock";
import { mapPool } from "@/lib/pipeline/pool";
import { okfCachePath } from "@/lib/okf/cache";
import { parseDocument } from "@/lib/okf/parse";
import { serializeDocument } from "@/lib/okf/serialize";
import { isHumanVerified } from "@/lib/okf/validate";
import type { AlignIndex } from "./align";
import { LINK_RE, normalizeHref, rewriteBundleHref } from "./mergeLinks";
import type { CompileClaim, CompileOutput } from "./types";

/**
 * Link-integrity guard for compile.
 *
 * The model freely writes markdown links in `paper.body` (and in concept/claim
 * bodies), so those links can point at files this compile never created. That
 * silently leaves dangling "concept" nodes in the library graph. This module:
 *
 * 1. verifies every internal `.md` link target exists in the store;
 * 2. auto-repairs topics/methods/entities dead links (align to an existing
 *    concept, else write a minimal stub page at the link target);
 * 3. throws `DeadLinkError` if any dead link remains, so compile hard-fails
 *    instead of silently producing an isolated node.
 *
 * The LLM output is also persisted to a rebuildable `.okf/` cache keyed by the
 * extract text, so a failed compile can resume from the write/guard phase on
 * the next run instead of paying the full model call again.
 */

const CONCEPT_DIRS: Record<string, string> = {
  topics: "Topic",
  methods: "Method",
  entities: "Entity",
  datasets: "Dataset",
  genes: "Gene",
  pathways: "Pathway",
};

export type DeadLink = { href: string; label: string; scope: string };

export class DeadLinkError extends Error {
  override readonly name = "DeadLinkError";
  constructor(
    public readonly deadLinks: DeadLink[],
    public readonly output: unknown,
    hint?: string,
  ) {
    super(
      hint ??
        `compile produced dead internal links: ${deadLinks
          .map((d) => `${d.href} (${d.label || "no label"}, ${d.scope})`)
          .join("; ")}`,
    );
  }
}

/** Rebuildable LLM-output snapshot so a failed compile can resume (not restart).
 * `stages` records which stages the snapshot was produced with; a cache from a
 * default run (no genes/pathways) must not answer an opt-in request. */
export type CompileCachePayload =
  | { kind: "full"; output: CompileOutput; stages?: string[] }
  | { kind: "claims"; claims: CompileClaim[] };

export function compileOutputCacheKey(extractText: string): string {
  return okfCachePath(`compile-${extractTextHash(extractText)}.json`);
}

/** Short fingerprint of an extract's text, reused for the skip-compiled check. */
export function extractTextHash(extractText: string): string {
  return createHash("sha256").update(extractText).digest("hex").slice(0, 16);
}

export async function saveCompileOutput(
  store: FileStore,
  extractText: string,
  payload: CompileCachePayload,
): Promise<void> {
  await store.write(compileOutputCacheKey(extractText), JSON.stringify(payload));
}

export async function loadCompileOutput(
  store: FileStore,
  extractText: string,
  requiredStages?: Set<string>,
): Promise<CompileCachePayload | undefined> {
  const path = compileOutputCacheKey(extractText);
  if (!(await store.exists(path))) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(utf8Decode(await store.read(path))) as CompileCachePayload;
    if (!parsed || typeof parsed !== "object" || !("kind" in parsed)) {
      return undefined;
    }
    // A snapshot without a stage list predates opt-in genes/pathways and was
    // produced with the full prompt, so it covers every request. A snapshot
    // WITH a list must cover the requested optional stages.
    if (parsed.kind === "full" && requiredStages && Array.isArray(parsed.stages)) {
      const recorded = new Set(parsed.stages);
      for (const stage of requiredStages) {
        if (!recorded.has(stage)) {
          return undefined;
        }
      }
    }
    return parsed;
  } catch {
    // Corrupt cache is treated as absent; the model is called fresh.
  }
  return undefined;
}

export async function clearCompileOutput(store: FileStore, extractText: string): Promise<void> {
  const path = compileOutputCacheKey(extractText);
  if (await store.exists(path)) {
    await store.remove(path);
  }
}

/** Internal (knowledge) links that a body wants to point at. */
export async function findDeadLinks(
  store: FileStore,
  bodies: Array<{ body: string; scope: string }>,
  knownPaths: string[] = [],
): Promise<DeadLink[]> {
  const known = new Set(knownPaths.map((path) => path.replace(/^\/+/, "")));
  const seen = new Set<string>();
  // Collect unique candidate hrefs first, then probe them with a bounded
  // worker pool — a serial exists() storm was the dominant cost of okf_check
  // on large libraries (one stat round-trip per unique dead-link candidate).
  const candidates: Array<{ href: string; label: string; scope: string; rel: string }> = [];
  for (const { body, scope } of bodies) {
    for (const match of body.matchAll(LINK_RE)) {
      const raw = match[2] ?? "";
      if (!raw || raw.includes("://") || raw.startsWith("#")) {
        continue;
      }
      const href = normalizeHref(raw);
      const rel = href.replace(/^\/+/, "");
      if (!rel.endsWith(".md")) {
        continue; // not a knowledge link (e.g. an image asset)
      }
      if (seen.has(rel) || known.has(rel)) {
        continue;
      }
      seen.add(rel);
      candidates.push({ href, label: (match[1] ?? "").trim(), scope, rel });
    }
  }
  const exists = await mapPool(candidates, 16, (candidate) =>
    store.exists(candidate.rel).then((hit) => (hit ? undefined : candidate)),
  );
  return exists.filter((item): item is { href: string; label: string; scope: string; rel: string } => item !== undefined);
}

function titleFromPath(rel: string): string {
  const base = rel.split("/").pop() ?? rel;
  return base.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim();
}

/**
 * Sanitize model-written bodies BEFORE anything is written. The model
 * hallucinates internal link targets freely — invented directories
 * (/paper/ singular, /domains/, …) and phantom paper paths — and a fresh
 * retry hallucinates a different name each time, so an enumerated allowlist
 * per failure can never converge. This pass applies one closed rule instead:
 *
 *   - target exists on disk or is about to be written (upcoming) → keep;
 *   - paper-like target whose label matches this paper → rewrite to paperHref;
 *   - anything else → unlink (keep the label text, drop the dead href).
 *
 * The final guard then only sees links that point at real pages, reserving
 * DeadLinkError for genuine integrity regressions.
 */
export async function sanitizeBodyLinks(
  store: FileStore,
  body: string,
  paperHref: string,
  upcoming: Set<string>,
): Promise<string> {
  const paperRel = paperHref.replace(/^\/+/, "");
  let next = body;
  for (const match of [...next.matchAll(LINK_RE)]) {
    const raw = match[2] ?? "";
    if (!raw || raw.includes("://") || raw.startsWith("#")) {
      continue;
    }
    const href = normalizeHref(raw);
    const rel = href.replace(/^\/+/, "");
    if (!rel.endsWith(".md")) {
      continue;
    }
    if (rel === paperRel || upcoming.has(rel) || (await store.exists(rel))) {
      continue;
    }
    const label = (match[1] ?? "").trim();
    const dir = rel.slice(0, rel.indexOf("/"));
    if ((dir === "paper" || dir === "papers") && paperLinkRelated(label, rel, paperRel)) {
      next = rewriteBundleHref(next, href, normalizeHref(paperRel));
      console.warn(`[okf] link guard: paper link ${href} -> ${paperHref} (invented paper target)`);
      continue;
    }
    if (CONCEPT_DIRS[dir]) {
      // Concept targets the model wrote with a truncated slug (e.g.
      // /topics/spatial-transcriptomics.md when the page is
      // /topics/spatial-transcriptomics-technologies.md): align to the
      // unique existing page whose slug starts with the dead one.
      const base = rel.split("/").pop()?.replace(/\.md$/i, "") ?? "";
      if (base) {
        const matches = (await listConceptDir(store, dir))
          .map((f) => f.replace(/\.md$/i, ""))
          .filter((f) => (f.split("/").pop() ?? "").startsWith(base));
        if (matches.length === 1) {
          const target = `/${matches[0]}.md`;
          next = rewriteBundleHref(next, href, target);
          console.warn(`[okf] link guard: concept link ${href} -> ${target} (slug prefix align)`);
          continue;
        }
      }
    }
    // Hallucinated directory / genuinely missing page: unlink, keep the text.
    next = unlinkBodyHref(next, raw, match[1] ?? "");
    console.warn(`[okf] link guard: unlinked dead target ${href} (label: ${label || "—"})`);
  }
  return next;
}

/** `[Label](href)` → `Label` for every occurrence of this exact link. */
function unlinkBodyHref(body: string, rawHref: string, rawLabel: string): string {
  const token = `[${rawLabel}](${rawHref})`;
  return body.split(token).join(rawLabel);
}

// Per-store memo of concept-dir listings: one compile sanitizes dozens of
// bodies and each may probe the same directory.
const conceptDirCache = new WeakMap<FileStore, Map<string, string[]>>();

async function listConceptDir(store: FileStore, dir: string): Promise<string[]> {
  let per = conceptDirCache.get(store);
  if (!per) {
    per = new Map();
    conceptDirCache.set(store, per);
  }
  const cached = per.get(dir);
  if (cached) {
    return cached;
  }
  const files = await store.list(`${dir}/`);
  per.set(dir, files);
  return files;
}

function paperLinkRelated(label: string, rel: string, paperRel: string): boolean {
  const fromLabel = (label || titleFromPath(rel))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^\d{4}-/, "");
  const fromPaper = (paperRel.split("/").pop() ?? paperRel)
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/^\d{4}-/, "");
  if (!fromLabel || !fromPaper) {
    return false;
  }
  const n = Math.min(fromLabel.length, fromPaper.length);
  if (n < 8) {
    // Paper acronyms (STORIES, CASCAT) are short but legitimate prefixes of
    // the full filename; requiring equality dropped those links.
    return fromLabel === fromPaper || (fromLabel.length >= 4 && fromPaper.startsWith(fromLabel));
  }
  return fromPaper.startsWith(fromLabel) || fromLabel.startsWith(fromPaper);
}

async function upsertMinimalConcept(
  store: FileStore,
  type: string,
  path: string,
  title: string,
  ctx: { paperTitle: string; paperHref: string; generated: { by: string; at: string } },
): Promise<void> {
  await withPathLock(path, async () => {
    if (await store.exists(path)) {
      const existing = parseDocument(utf8Decode(await store.read(path)));
      if (isHumanVerified(existing.frontmatter)) {
        return;
      }
    }
    const body =
      `Referenced from [${ctx.paperTitle}](${ctx.paperHref}).\n\n` +
      "(_Auto-created by the compile link guard. This page is a stub pending review._)";
    await store.write(path, serializeDocument({ type, title, tags: [], generated: ctx.generated }, body));
  });
}

async function repairConceptLinks(
  store: FileStore,
  vocab: AlignIndex,
  body: string,
  ctx: { paperTitle: string; paperHref: string; generated: { by: string; at: string } },
): Promise<{ body: string; written: string[] }> {
  let next = body;
  const written: string[] = [];
  const seen = new Set<string>();
  for (const match of [...next.matchAll(LINK_RE)]) {
    const raw = match[2] ?? "";
    if (!raw || raw.includes("://") || raw.startsWith("#")) {
      continue;
    }
    const href = normalizeHref(raw);
    const rel = href.replace(/^\/+/, "");
    if (!rel.endsWith(".md") || seen.has(rel) || (await store.exists(rel))) {
      continue;
    }
    seen.add(rel);
    const dir = rel.slice(0, rel.indexOf("/"));
    const type = CONCEPT_DIRS[dir];
    if (!type) {
      continue;
    }
    const label = (match[1] ?? "").trim();
    // Prefer rewriting the link to an already-existing, near-synonym concept.
    const aligned = vocab.lookupAll(type, label)[0];
    if (aligned && normalizeHref(aligned.path) !== href) {
      next = rewriteBundleHref(next, href, aligned.path);
      console.warn(`[okf] link guard: ${href} -> /${aligned.path.replace(/^\/+/, "")} (aligned to ${aligned.title})`);
      continue;
    }
    // Otherwise materialize the missing concept at the exact link target.
    const title = label || titleFromPath(rel);
    await upsertMinimalConcept(store, type, rel, title, ctx);
    vocab.add({ path: rel, id: rel.replace(/\.md$/i, ""), type, title, aliases: [] });
    written.push(rel);
    console.warn(`[okf] link guard: wrote stub concept ${rel} (${title})`);
  }
  return { body: next, written };
}

export type GuardInput = {
  paperBody: string;
  /** Verify the paper body too. Full compiles regenerate it; claims-only and
   * partial recompiles keep a pre-existing body, so they skip it. Default true. */
  checkPaperBody?: boolean;
  /** Other bodies written this run (concepts, claims). */
  extraBodies?: Array<{ body: string; scope: string }>;
  /** Auto-repair topics/methods/entities dead links. */
  repairConcepts?: boolean;
  vocab?: AlignIndex;
  paperTitle?: string;
  paperHref?: string;
  generated?: { by: string; at: string };
  /** Paths this compile will still write (e.g. the paper itself). */
  knownPaths?: string[];
  /** Payload to attach to DeadLinkError so the failed run can be resumed. */
  output: unknown;
};

/** Repair repairable dead links, then hard-fail on anything left. */
export async function guardCompileLinks(
  store: FileStore,
  input: GuardInput,
): Promise<{ paperBody: string; written: string[] }> {
  let paperBody = input.paperBody;
  const written: string[] = [];
  if (input.repairConcepts && input.vocab && input.paperTitle && input.paperHref && input.generated) {
    const result = await repairConceptLinks(store, input.vocab, paperBody, {
      paperTitle: input.paperTitle,
      paperHref: input.paperHref,
      generated: input.generated,
    });
    paperBody = result.body;
    written.push(...result.written);
  }
  const bodies: Array<{ body: string; scope: string }> = [];
  if (input.checkPaperBody !== false) {
    bodies.push({ body: paperBody, scope: "paper" });
  }
  bodies.push(...(input.extraBodies ?? []));
  const dead = await findDeadLinks(store, bodies, input.knownPaths ?? []);
  if (dead.length > 0) {
    throw new DeadLinkError(dead, input.output);
  }
  return { paperBody, written };
}
