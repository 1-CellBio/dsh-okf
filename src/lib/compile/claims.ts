import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { withPathLock } from "@/lib/fs/pathLock";
import { mapPool } from "@/lib/pipeline/pool";
import {
  asString,
  claimPathFor,
  claimTitleKey,
  paperConceptId,
  quoteFingerprint,
  snapQuoteToExtract,
} from "@/lib/okf/identity";
import { parseDocument } from "@/lib/okf/parse";
import { serializeDocument } from "@/lib/okf/serialize";
import { isHumanVerified } from "@/lib/okf/validate";
import type { Frontmatter } from "@/types/okf";
import { ensureLink } from "./mergeLinks";
import type { CompileClaim } from "./types";

export const CLAIM_STANCES = ["reports", "result", "method", "limitation", "comparison"] as const;
export type ClaimStance = (typeof CLAIM_STANCES)[number];
export type ClaimConfidence = "extracted" | "reviewed" | "disputed";

function asStance(value: unknown): ClaimStance | undefined {
  return CLAIM_STANCES.find((item) => item === value);
}

export function evidenceQuote(frontmatter: Frontmatter): string {
  const evidence = frontmatter.evidence;
  if (evidence && typeof evidence === "object" && evidence !== null && "quote" in evidence) {
    return asString((evidence as { quote: unknown }).quote) ?? "";
  }
  return "";
}

export function segmentExtract(text: string, size = 8_000): string[] {
  if (text.length <= size) {
    return text.trim() ? [text] : [];
  }
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= size) {
      parts.push(rest);
      break;
    }
    let cut = rest.lastIndexOf("\n\n", size);
    if (cut < size * 0.5) {
      cut = rest.lastIndexOf("\n", size);
    }
    if (cut < size * 0.5) {
      cut = size;
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  return parts.filter((part) => part.trim().length > 0);
}

export function formatClaimBody(input: {
  quote: string;
  paperTitle: string;
  paperHref: string;
  extra?: string;
}): string {
  const extra = input.extra?.trim() ?? "";
  return ensureLink(
    [`> ${input.quote.trim()}`, extra].filter(Boolean).join("\n\n"),
    input.paperTitle,
    input.paperHref,
  );
}

export async function writeClaims(
  store: FileStore,
  input: {
    paperPath: string;
    paperTitle: string;
    doi?: string;
    extractPath?: string;
    extractText: string;
    claims: CompileClaim[];
    generated: { by: string; at: string };
  },
): Promise<{ written: string[]; skipped: string[]; omitted: number; hrefs: { title: string; href: string }[] }> {
  const written: string[] = [];
  const skipped: string[] = [];
  const hrefs: { title: string; href: string }[] = [];
  let omitted = 0;
  const paperId = paperConceptId(input.paperPath);
  const paperHref = `/${input.paperPath.replace(/^\/+/, "")}`;
  const extractId = input.extractPath ? paperConceptId(input.extractPath) : undefined;

  // Claims are independent pages (each write is path-locked); a bounded pool
  // turns the serial exists→read→write round-trips of a 30-claim paper into
  // a handful of parallel batches. mapPool preserves claim order, so hrefs
  // and written/skipped lists stay deterministic.
  const results = await mapPool(input.claims, 8, async (claim) => {
    const title = claim.title.trim();
    const quote = claim.quote.trim();
    if (!title || !quote) {
      return null;
    }
    const path = claimPathFor(input.paperPath, title);
    const snapped = snapQuoteToExtract(quote, input.extractText);
    if (!snapped) {
      omitted += 1;
      return null;
    }
    const storedQuote = snapped;
    const confidence: ClaimConfidence = "extracted";

    // Serialize read-check-write per claim path so concurrent compile jobs
    // cannot both see "not exists" and overwrite each other's claim.
    const result = await withPathLock(path, async () => {
      if (await store.exists(path)) {
        const existing = parseDocument(utf8Decode(await store.read(path)));
        if (isHumanVerified(existing.frontmatter) || asString(existing.frontmatter.confidence) === "reviewed") {
          return "skipped" as const;
        }
      }
      const body = formatClaimBody({
        quote: storedQuote,
        paperTitle: input.paperTitle,
        paperHref,
        extra: claim.body,
      });
      const frontmatter: Frontmatter = {
        type: "Claim",
        title,
        paper: paperId,
        ...(input.doi ? { doi: input.doi } : {}),
        stance: asStance(claim.stance) ?? "reports",
        confidence,
        evidence: {
          quote: storedQuote,
          ...(extractId ? { extract: extractId } : {}),
          locator: null,
        },
        generated: input.generated,
      };
      await store.write(path, serializeDocument(frontmatter, body));
      return "written" as const;
    });

    return { path, title, result };
  });

  for (const result of results) {
    if (!result) {
      continue;
    }
    hrefs.push({ title: result.title, href: `/${result.path}` });
    if (result.result === "skipped") {
      skipped.push(result.path);
    } else {
      written.push(result.path);
    }
  }

  return { written, skipped, omitted, hrefs };
}

export async function listClaimsForPaper(
  store: FileStore,
  paperPathOrId: string,
): Promise<{ path: string; title: string; confidence: string }[]> {
  const paperId = paperConceptId(paperPathOrId);
  const prefix = `claims/${paperId.replace(/^papers\//, "")}--`;
  const paths = (await store.list("claims/")).filter((path) => path.endsWith(".md"));
  const out: { path: string; title: string; confidence: string }[] = [];
  for (const path of paths) {
    const doc = parseDocument(utf8Decode(await store.read(path)));
    if (asString(doc.frontmatter.type) !== "Claim") {
      continue;
    }
    const paper = asString(doc.frontmatter.paper);
    if (paper && paperConceptId(paper) !== paperId) {
      continue;
    }
    if (!paper && !path.startsWith(prefix)) {
      continue;
    }
    out.push({
      path,
      title: asString(doc.frontmatter.title) ?? path,
      confidence: asString(doc.frontmatter.confidence) ?? "extracted",
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function claimMergeKey(frontmatter: Frontmatter, path: string): string {
  const paper = asString(frontmatter.paper);
  const title = asString(frontmatter.title);
  if (paper && title) {
    return `title:${claimTitleKey(paper, title)}`;
  }
  const quote = evidenceQuote(frontmatter);
  if (paper && quote) {
    return `quote:${paperConceptId(paper)}|${quoteFingerprint(quote)}`;
  }
  return `path:${path}`;
}
