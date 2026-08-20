import type { SurveyRetrieval } from "./scope";

export const SURVEY_SYSTEM_PROMPT = `You write a literature-survey draft from a local OKF knowledge bundle.
Return markdown body only (no YAML frontmatter).
Rules:
- This is a local folder, not a complete field search. Say so in the opening paragraph.
- Cite only with OKF links: [Title](/papers/....md) or [Title](/claims/....md) using ids from the retrieval set.
- Do not invent Paper ids, Claim ids, or DOIs.
- Causal claims ("therefore", "this proves") require a Claim link.
- Prefer reviewed claims in the main sections. Put extracted-only claims in an appendix if you mention them.
- Do not wrap the coverage appendix; the caller appends it.
Sections, in order:
1. Scope and retrieval strategy
2. Timeline
3. Method lineage
4. Claim contrast (note stance conflicts)
5. Open questions`;

export function surveyUserPrompt(retrieval: SurveyRetrieval, title: string): string {
  const paperLines = retrieval.yearBuckets.flatMap((bucket) => {
    const head = `### ${bucket.year} (${bucket.featured.length + bucket.listed.length} papers)`;
    const featured = bucket.featured.map((paper) => {
      const published = paper.published ? ` published=${paper.published}` : "";
      const digest = retrieval.oversized ? 280 : 500;
      return `- ${paper.id} ${paper.title ?? paper.id}${published}\n  ${paper.body.replace(/\s+/g, " ").trim().slice(0, digest)}`;
    });
    const listed =
      bucket.listed.length > 0
        ? [
            `Titles only (${bucket.listed.length}):`,
            ...bucket.listed.map((paper) => `- ${paper.id} ${paper.title ?? paper.id}`),
          ]
        : [];
    return [head, ...featured, ...listed];
  });
  const claimLines = [
    ...retrieval.reviewedClaims.map(
      (claim) =>
        `- REVIEWED ${claim.id} ${claim.title ?? claim.id} paper=${claim.paper ?? ""} stance=${claim.stance ?? ""}\n  ${claim.body.replace(/\s+/g, " ").trim().slice(0, 400)}`,
    ),
    ...retrieval.extractedClaims.map(
      (claim) =>
        `- EXTRACTED ${claim.id} ${claim.title ?? claim.id} paper=${claim.paper ?? ""} stance=${claim.stance ?? ""}`,
    ),
  ];
  const methodLines = retrieval.methods.map((method) => `- ${method.id} ${method.title ?? method.id}`);
  return [
    `Survey title: ${title}`,
    retrieval.scope.question ? `Research question: ${retrieval.scope.question}` : "",
    `Scope topics: ${(retrieval.scope.topics ?? (retrieval.scope.topic ? [retrieval.scope.topic] : [])).join(", ") || "(all)"}`,
    `Years: ${retrieval.scope.from ?? "?"}–${retrieval.scope.to ?? "?"}`,
    retrieval.oversized
      ? `Scope has ${retrieval.papers.length} papers (>200). Digests are sampled per year; titles-only rows remain citable.`
      : "",
    "",
    "## Papers in retrieval set",
    paperLines.length > 0 ? paperLines.join("\n") : "(none)",
    "",
    "## Claims in retrieval set",
    claimLines.length > 0 ? claimLines.join("\n") : "(none)",
    "",
    "## Methods",
    methodLines.length > 0 ? methodLines.join("\n") : "(none)",
    "",
    "Write the survey body now. Use only the ids above.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function surveyRepairPrompt(draft: string, illegal: string[]): string {
  return [
    "These Paper/Claim links are not in the retrieval set and must be removed or replaced with an in-set id:",
    ...illegal.map((id) => `- ${id}`),
    "",
    "Rewrite the draft. Keep the same sections. Return markdown body only.",
    "",
    draft,
  ].join("\n");
}
