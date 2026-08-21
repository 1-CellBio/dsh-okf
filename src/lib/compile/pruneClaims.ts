import { evidenceQuote } from "@/lib/compile/claims";
import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { asString, paperConceptId } from "@/lib/okf/identity";
import { parseDocument } from "@/lib/okf/parse";
import { serializeDocument } from "@/lib/okf/serialize";
import { snapQuoteToExtract } from "@/lib/okf/quote";
import { isHumanVerified } from "@/lib/okf/validate";
import type { Frontmatter } from "@/types/okf";

export type PruneUnquotedResult = {
  pruned: number;
  healed: number;
  kept: number;
};

function withEvidenceQuote(frontmatter: Frontmatter, quote: string): Frontmatter {
  const evidence = frontmatter.evidence;
  const base =
    evidence && typeof evidence === "object" && evidence !== null
      ? { ...(evidence as Record<string, unknown>) }
      : {};
  return { ...frontmatter, evidence: { ...base, quote } };
}

/**
 * Claims whose quote cannot be snapped to the extract are not citable.
 * Heal those that snap after folding; deprecate the rest. Human-reviewed
 * pages are left alone.
 */
export async function pruneUnquotedClaims(store: FileStore): Promise<PruneUnquotedResult> {
  const extracts = new Map<string, string>();
  for (const path of (await store.list("extracts/")).filter((item) => item.endsWith(".md"))) {
    const doc = parseDocument(utf8Decode(await store.read(path)));
    const paper = asString(doc.frontmatter.paper);
    if (paper && !extracts.has(paperConceptId(paper))) {
      extracts.set(paperConceptId(paper), doc.body);
    }
  }

  let pruned = 0;
  let healed = 0;
  let kept = 0;
  for (const path of (await store.list("claims/")).filter((item) => item.endsWith(".md"))) {
    const doc = parseDocument(utf8Decode(await store.read(path)));
    if (asString(doc.frontmatter.type) !== "Claim") {
      continue;
    }
    if (isHumanVerified(doc.frontmatter) || asString(doc.frontmatter.confidence) === "reviewed") {
      kept += 1;
      continue;
    }
    if (asString(doc.frontmatter.status) === "deprecated") {
      continue;
    }
    const quote = evidenceQuote(doc.frontmatter);
    const paper = asString(doc.frontmatter.paper);
    const extract = paper ? extracts.get(paperConceptId(paper)) : undefined;
    const snapped = quote && extract ? snapQuoteToExtract(quote, extract) : undefined;
    if (snapped) {
      const confidence = asString(doc.frontmatter.confidence);
      if (snapped !== quote || confidence === "disputed") {
        const next: Frontmatter = {
          ...withEvidenceQuote(doc.frontmatter, snapped),
          confidence: "extracted",
        };
        if (asString(next.status) === "draft" && confidence === "disputed") {
          next.status = "stable";
        }
        await store.write(path, serializeDocument(next, doc.body));
        healed += 1;
      } else {
        kept += 1;
      }
      continue;
    }
    await store.write(
      path,
      serializeDocument(
        {
          ...doc.frontmatter,
          confidence: "disputed",
          status: "deprecated",
        },
        doc.body,
      ),
    );
    pruned += 1;
  }
  return { pruned, healed, kept };
}
