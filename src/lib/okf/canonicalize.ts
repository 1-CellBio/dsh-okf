import { rewriteBundleHref, mergePaperLinks } from "@/lib/compile/mergeLinks";
import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { listIndexableMarkdown } from "@/lib/index/catalog";
import { asString, asTags, unionTags } from "@/lib/okf/identity";
import { conceptPath, toConceptId } from "@/lib/okf/links";
import { parseDocument } from "@/lib/okf/parse";
import { serializeDocument } from "@/lib/okf/serialize";
import { isHumanVerified } from "@/lib/okf/validate";
import { normalizeAlignKey } from "@/lib/compile/align";
import type { Frontmatter } from "@/types/okf";

const CANONICAL_TYPES = new Set(["Topic", "Method", "Entity", "Dataset", "Gene", "Pathway"]);

export type CanonicalizeResult = {
  from: string;
  to: string;
  rewritten: string[];
};

function uniqueAliases(canonicalTitle: string, ...lists: unknown[]): string[] {
  const skip = normalizeAlignKey(canonicalTitle);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    const values = typeof list === "string" ? [list] : asTags(list);
    for (const value of values) {
      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }
      if (normalizeAlignKey(trimmed) === skip) {
        continue;
      }
      const key = normalizeAlignKey(trimmed);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out;
}

async function readDoc(
  store: FileStore,
  path: string,
): Promise<{ frontmatter: Frontmatter; body: string }> {
  if (!(await store.exists(path))) {
    throw new Error(`canonicalize: missing ${path}`);
  }
  return parseDocument(utf8Decode(await store.read(path)));
}

function asType(frontmatter: Frontmatter): string {
  return asString(frontmatter.type) ?? "";
}

function isRedirect(frontmatter: Frontmatter, path: string): boolean {
  if (asString(frontmatter.status) === "deprecated") {
    return true;
  }
  const canonical = asString(frontmatter.canonical);
  return Boolean(canonical && conceptPath(canonical) !== path);
}

export async function canonicalizeConcept(
  store: FileStore,
  fromInput: string,
  toInput: string,
): Promise<CanonicalizeResult> {
  const fromPath = conceptPath(fromInput);
  const toPath = conceptPath(toInput);
  if (fromPath === toPath) {
    throw new Error("canonicalize: --from and --to must be different paths");
  }

  const from = await readDoc(store, fromPath);
  const to = await readDoc(store, toPath);
  const fromType = asType(from.frontmatter);
  const toType = asType(to.frontmatter);
  if (!CANONICAL_TYPES.has(fromType) || !CANONICAL_TYPES.has(toType)) {
    throw new Error("canonicalize: only Topic, Method, Entity, Dataset, Gene, and Pathway pages can be merged");
  }
  if (fromType !== toType) {
    throw new Error(`canonicalize: type mismatch (${fromType} vs ${toType})`);
  }

  const toTitle = asString(to.frontmatter.title) ?? toConceptId(toPath);
  const fromTitle = asString(from.frontmatter.title) ?? toConceptId(fromPath);
  const toDeprecated = isRedirect(to.frontmatter, toPath);
  const takeFromBody =
    toDeprecated || (!isHumanVerified(to.frontmatter) && isHumanVerified(from.frontmatter));
  const nextBody = takeFromBody
    ? mergePaperLinks(to.body, from.body)
    : mergePaperLinks(from.body, to.body);

  const aliases = uniqueAliases(
    toTitle,
    to.frontmatter.aliases,
    fromTitle,
    from.frontmatter.aliases,
  );
  const nextFrontmatter: Frontmatter = {
    ...to.frontmatter,
    type: toType,
    title: toTitle,
    tags: unionTags(to.frontmatter.tags, from.frontmatter.tags),
    status: toDeprecated ? "stable" : (asString(to.frontmatter.status) ?? "stable"),
  };
  delete nextFrontmatter.canonical;
  if (aliases.length > 0) {
    nextFrontmatter.aliases = aliases;
  } else {
    delete nextFrontmatter.aliases;
  }
  if (takeFromBody && isHumanVerified(from.frontmatter) && !isHumanVerified(to.frontmatter)) {
    nextFrontmatter.verified = from.frontmatter.verified;
  }

  const rewritten: string[] = [];
  const paths = await listIndexableMarkdown(store);
  for (const path of paths) {
    if (path === fromPath) {
      continue;
    }
    const doc = path === toPath ? { frontmatter: nextFrontmatter, body: nextBody } : await readDoc(store, path);
    const body = rewriteBundleHref(doc.body, fromPath, toPath);
    let frontmatter = { ...doc.frontmatter };
    const canonical = asString(frontmatter.canonical);
    if (canonical && conceptPath(canonical) === fromPath) {
      frontmatter = { ...frontmatter, canonical: toConceptId(toPath) };
    }
    const changed = path === toPath || body !== doc.body || canonical !== asString(frontmatter.canonical);
    if (!changed) {
      continue;
    }
    await store.write(path, serializeDocument(frontmatter, body));
    rewritten.push(path);
  }

  if (!rewritten.includes(toPath)) {
    await store.write(toPath, serializeDocument(nextFrontmatter, rewriteBundleHref(nextBody, fromPath, toPath)));
    rewritten.push(toPath);
  }

  const redirect: Frontmatter = {
    type: fromType,
    title: fromTitle,
    status: "deprecated",
    canonical: toConceptId(toPath),
  };
  const redirectBody = `Canonical page: [${toTitle}](/${toPath})\n`;
  await store.write(fromPath, serializeDocument(redirect, redirectBody));

  return { from: fromPath, to: toPath, rewritten };
}
