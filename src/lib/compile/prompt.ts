export const EXTRACT_CHAR_LIMIT = 12_000;

/**
 * Extraction schema version. Bump whenever the compile prompt/output schema
 * changes in a way that should re-extract already-compiled papers (v2 added
 * datasets/genes/pathways). Papers stamped with the current version and an
 * unchanged extract hash are skipped by batch compiles, so an accidental
 * `okf_compile` rerun no longer pays the full LLM cost for every paper.
 */
export const COMPILE_SCHEMA_VERSION = 2;


/**
 * Genes/pathways are opt-in stages: the default prompt omits their schema and
 * rules entirely (saves tokens and keeps unrelated papers from growing
 * gene/pathway stubs). Pass include.genes/include.pathways when the user asked
 * for them.
 */
export function compileSystemPrompt(include: { genes: boolean; pathways: boolean }): string {
  const bodyLinkTargets = [
    "[Title](/topics/slug.md)",
    "[Title](/methods/slug.md)",
    "[Title](/entities/slug.md)",
    "[Title](/datasets/slug.md)",
    ...(include.genes ? ["[Title](/genes/slug.md)"] : []),
    ...(include.pathways ? ["[Title](/pathways/slug.md)"] : []),
  ].join(", ");
  const geneSchema = include.genes
    ? `\n  "genes": [{ "title": "gene symbol, e.g. TP53", "body": "markdown" }],`
    : "";
  const pathwaySchema = include.pathways
    ? `\n  "pathways": [{ "title": "pathway name, e.g. PI3K-AKT signaling", "body": "markdown" }],`
    : "";
  const geneRules = include.genes
    ? `\n- genes: extract the genes the paper studies or reports (standard HUGO symbols). Link them from paper and relevant topics.`
    : "";
  const pathwayRules = include.pathways
    ? `\n- pathways: extract the biological pathways the paper involves (e.g. cell signaling or metabolic pathways).`
    : "";
  const genePathwayQuality = include.genes || include.pathways
    ? `\n- For genes and pathways, extract the ones the paper actually analyzes or discusses; prefer concrete named genes/pathways over generic phrases.`
    : "";
  const omitted = !include.genes || !include.pathways
    ? `\n- Omit the ${[!include.genes && "genes", !include.pathways && "pathways"].filter(Boolean).join(" and ")} field(s); they are extracted only when explicitly requested.`
    : "";
  return `You compile scientific PDF extracts into OKF concepts.
Return ONLY a JSON object (optional markdown fence) with this shape:
{
  "paper": {
    "title": "string",
    "published": "YYYY-MM-DD or YYYY if only year is known",
    "doi": "string",
    "authors": ["string"],
    "venue": "string",
    "description": "one sentence",
    "tags": ["string"],
    "body": "markdown digest, NOT the full paper. Link related concepts as ${bodyLinkTargets}."
  },
  "topics": [{ "title": "string", "body": "markdown" }],
  "methods": [{ "title": "string", "body": "markdown" }],
  "entities": [{ "title": "string", "tags": ["org"|"other"], "body": "markdown" }],
  "datasets": [{ "title": "dataset name/code, e.g. TCGA-BRCA", "body": "markdown" }],${geneSchema}${pathwaySchema}
  "claims": [{ "title": "one-sentence claim", "quote": "verbatim substring of the extract", "stance": "reports"|"result"|"method"|"limitation"|"comparison" }]
}
Rules:
- Paper body is a compiled digest (abstract, claims, links), never the raw extract dump.
- published is the scientific publication date, not today's date.
- If the date is unknown, omit published.
- Use lowercase hyphenated slugs in markdown links that match the titles you emit.
- Internal markdown links may ONLY target /topics/, /methods/, /entities/, /datasets/, /papers/ (and /genes/, /pathways/ when requested). Never invent other directory names such as /paper/ or /domains/.
- Prefer existing concept titles from the user message. Do not invent a near-synonym page when one already exists.
- Each claim quote MUST appear in the extract. Omit claims you cannot quote.
- datasets: extract every dataset the paper uses or produces (resource name/code). datasets are a separate concept type, not entities.${geneRules}${pathwayRules}${genePathwayQuality}${omitted}`;
}

export function compileUserPrompt(input: {
  extractText: string;
  pdfFilename: string;
  pdfTitle?: string;
  pdfAuthor?: string;
  pdfCreationDate?: string;
  vocabulary?: string;
}): string {
  return [
    `PDF filename: ${input.pdfFilename}`,
    input.pdfTitle ? `PDF Title metadata: ${input.pdfTitle}` : "",
    input.pdfAuthor ? `PDF Author metadata: ${input.pdfAuthor}` : "",
    input.pdfCreationDate ? `PDF CreationDate metadata: ${input.pdfCreationDate}` : "",
    input.vocabulary ? `\n${input.vocabulary}` : "",
    "",
    "Extract:",
    input.extractText,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function repairUserPrompt(previous: string, error: string): string {
  return `The previous JSON was invalid (${error}). Return corrected JSON only.\n\nPrevious output:\n${previous.slice(0, 8000)}`;
}
