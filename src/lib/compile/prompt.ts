/**
 * Per-call extract window, not a document cap. Compile splits the full extract
 * into segments of this size (paragraph-aware) and map-reduces every segment:
 * the first pass writes biblio + digest + concepts + claims; later passes add
 * concepts/claims from the rest of the paper. Raise this only if the harness
 * model context grows; lowering it increases call count, not coverage.
 */
export const EXTRACT_CHAR_LIMIT = 12_000;

/**
 * How many tail segments compile in parallel. The head segment always runs
 * first so later passes can align to titles it already emitted.
 */
export const SEGMENT_COMPILE_CONCURRENCY = 3;

/**
 * Extraction schema version. Bump whenever the compile prompt/output schema
 * changes in a way that should re-extract already-compiled papers (v2 added
 * datasets/genes/pathways; v3 map-reduces every extract segment instead of
 * digesting only the first 12k characters). Papers stamped with the current
 * version and an unchanged extract hash are skipped by batch compiles.
 */
export const COMPILE_SCHEMA_VERSION = 3;


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
- Prefer existing concept titles from the user message. Do not invent a near-synonym page when one already exists; a longer name or a parenthetical abbreviation of an existing title should reuse that title.
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

/**
 * Continuation pass for extract segments after the first. Does not re-emit
 * bibliography; it only adds concepts, claims, and digest notes from this
 * window so methods/results/limitations later in the PDF are not dropped.
 */
export function compileSegmentSystemPrompt(include: { genes: boolean; pathways: boolean }): string {
  const extra = [
    include.genes ? `"genes": [{ "title": "HUGO symbol", "body": "markdown" }],` : "",
    include.pathways ? `"pathways": [{ "title": "pathway name", "body": "markdown" }],` : "",
  ]
    .filter(Boolean)
    .join("\n  ");
  const omit = !include.genes || !include.pathways
    ? `\n- Omit the ${[!include.genes && "genes", !include.pathways && "pathways"].filter(Boolean).join(" and ")} field(s).`
    : "";
  return `You continue compiling a scientific PDF extract. This is NOT the start of the paper.
Return ONLY a JSON object (optional markdown fence):
{
  "additions": "markdown bullets of results, methods, limitations, or datasets from THIS segment that belong in the paper digest. Empty string if nothing new.",
  "topics": [{ "title": "string", "body": "markdown" }],
  "methods": [{ "title": "string", "body": "markdown" }],
  "entities": [{ "title": "string", "tags": ["org"|"other"], "body": "markdown" }],
  "datasets": [{ "title": "dataset name/code", "body": "markdown" }],${extra ? `\n  ${extra}` : ""}
  "claims": [{ "title": "one-sentence claim", "quote": "verbatim substring of this segment", "stance": "reports"|"result"|"method"|"limitation"|"comparison" }]
}
Rules:
- Cover THIS segment fully. Do not refuse because the opening was already compiled.
- Prefer existing titles listed in the user message; do not invent a near-synonym.
- Each claim quote MUST appear in this segment. Omit claims you cannot quote.
- additions is extra digest material only, never a second paper title or bibliography.${omit}`;
}

export function compileSegmentUserPrompt(input: {
  paperTitle: string;
  segmentIndex: number;
  segmentCount: number;
  extractText: string;
  knownTitles?: string;
  vocabulary?: string;
}): string {
  return [
    `Paper: ${input.paperTitle}`,
    `Segment ${input.segmentIndex + 1} of ${input.segmentCount} (later part of the same extract).`,
    input.knownTitles ? `\nAlready extracted titles (reuse these when the same concept appears):\n${input.knownTitles}` : "",
    input.vocabulary ? `\n${input.vocabulary}` : "",
    "",
    "Extract segment:",
    input.extractText,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
