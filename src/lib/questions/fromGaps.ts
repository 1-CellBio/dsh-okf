import type { FileStore } from "@/lib/fs/types";
import type { CoverageGap } from "@/lib/coverage/gaps";
import { generatedBy } from "@/lib/okf/generated";
import { conceptPath } from "@/lib/okf/links";
import { serializeDocument } from "@/lib/okf/serialize";
import { conceptSlug } from "@/lib/okf/slug";
import type { Frontmatter } from "@/types/okf";

const DRAFT_CAP = 50;

function topicSlug(topicId: string): string {
  return topicId.replace(/^topics\//, "");
}

function hubSlug(hubId: string): string {
  return hubId.replace(/^(methods|datasets|genes|pathways)\//, "");
}

function paperSlug(paperId: string): string {
  return paperId.replace(/^papers\//, "");
}

export function questionPathForGap(gap: CoverageGap): string {
  if (gap.kind === "missing_year" && gap.topicId && gap.year) {
    return `questions/${conceptSlug(`gap-${topicSlug(gap.topicId)}-${gap.year}`)}.md`;
  }
  if (gap.kind.startsWith("missing_") && gap.topicId && gap.hubId) {
    return `questions/${conceptSlug(`gap-${topicSlug(gap.topicId)}-${hubSlug(gap.hubId)}`)}.md`;
  }
  if (gap.kind === "undated_paper" && gap.paperId) {
    return `questions/${conceptSlug(`gap-undated-${paperSlug(gap.paperId)}`)}.md`;
  }
  return `questions/${conceptSlug(gap.id)}.md`;
}

function questionBody(gap: CoverageGap): string {
  const topicLink = gap.topicId
    ? `[${gap.topicTitle ?? gap.topicId}](/${conceptPath(gap.topicId)})`
    : undefined;
  const hubLink = gap.hubId ? `[${gap.hubTitle ?? gap.hubId}](/${conceptPath(gap.hubId)})` : undefined;
  const paperLink = gap.paperId ? `[${gap.paperId}](/${conceptPath(gap.paperId)})` : undefined;
  const lines = [gap.detail, "", "This is a coverage gap in the local OKF bundle, not a claim about the whole literature."];
  const links = [topicLink, hubLink, paperLink].filter(Boolean);
  if (links.length > 0) {
    lines.push("", ...links.map((link) => `- ${link}`));
  }
  return `${lines.join("\n")}\n`;
}

export async function draftQuestionsFromGaps(
  store: FileStore,
  gaps: CoverageGap[],
  at = new Date().toISOString(),
): Promise<{ written: string[]; skipped: string[] }> {
  const written: string[] = [];
  const skipped: string[] = [];
  for (const gap of gaps.slice(0, DRAFT_CAP)) {
    const path = questionPathForGap(gap);
    if (await store.exists(path)) {
      skipped.push(path);
      continue;
    }
    const frontmatter: Frontmatter = {
      type: "Question",
      title: gap.title,
      status: "draft",
      tags: ["gap", gap.kind],
      ...(gap.topicId ? { topic: gap.topicId } : {}),
      generated: { by: generatedBy("coverage"), at },
    };
    await store.write(path, serializeDocument(frontmatter, questionBody(gap)));
    written.push(path);
  }
  return { written, skipped };
}
