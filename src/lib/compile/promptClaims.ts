export const CLAIMS_SYSTEM_PROMPT = `Extract atomic scientific claims from this extract segment.
Return ONLY a JSON object (optional markdown fence):
{ "claims": [{ "title": "one-sentence claim", "quote": "verbatim substring of the extract", "stance": "reports"|"result"|"method"|"limitation"|"comparison" }] }
Rules:
- quote MUST be copied verbatim from the extract (whitespace may differ only trivially).
- Skip anything you cannot quote from the extract.
- Prefer results, methods, and limitations over background.`;

export function claimsUserPrompt(paperTitle: string, segment: string): string {
  return `Paper: ${paperTitle}\n\nExtract segment:\n${segment}`;
}
