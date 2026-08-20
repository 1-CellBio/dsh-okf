import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-settings";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { GenericCallView, JsonValue, ToolRunContext } from "@deepseek-ai/dsh-tools";
import path from "node:path";
import {
  backlinksOp,
  bibForSurvey,
  citeCheckOp,
  exportSurveyOp,
  getConcept,
  libraryGraphOp,
  listCoverage,
  neighborsOp,
  comparePapersOp,
  gatherEvidenceOp,
  libraryCheckOp,
  libraryStatsOp,
  mergeOkfOp,
  packOkfOp,
  saveNoteOp,
  saveSurveyOp,
  searchOkf,
  syncVectorsOp,
} from "./okf-ops";
import {
  runCompileJob,
  runIngestJob,
  runSurveyJob,
  startOkfJob,
  type CompileJobArgs,
  type IngestJobArgs,
  type SurveyJobArgs,
} from "./jobs";
import { LineLog } from "./log-buffer";
import { resolveHostPath, sessionCwd, type PluginPaths } from "./paths";
import { openSession } from "./session";
import { OKF_SETTINGS_NS, type PathSource } from "./settings";
import { okfHelp } from "./help";

const jsonOutput = {
  schema: { type: "json" as const },
  render: (_args: unknown, value: JsonValue) => [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
};

function present(title: string, kind: GenericCallView["kind"], rawInput?: unknown): GenericCallView {
  return { card: "generic", title, kind, ...(rawInput !== undefined ? { rawInput } : {}) };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  return items.length > 0 ? items : undefined;
}

function pathsOf(getPaths: PathSource, exec?: ToolRunContext): PluginPaths {
  return getPaths(sessionCwd(exec));
}

function packStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** Boundary cast: tool results are lossless JSON by contract, so adapt the
 * statically-shaped return values to the JsonValue declared by `jsonOutput`. */
function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

async function maybeBackground(
  ctx: Context,
  exec: ToolRunContext,
  background: boolean | undefined,
  spec: Parameters<typeof startOkfJob>[2],
  runNow: (signal: AbortSignal) => Promise<unknown>,
): Promise<unknown> {
  if (background === false) {
    return runNow(exec.signal);
  }
  return startOkfJob(ctx, exec, spec);
}

export function registerTools(ctx: Context, getPaths: PathSource): void {
  ctx.tools.register(defineTool({
    name: "okf_help",
    description:
      "Return the OKF library usage guide and copy-paste example prompts. Call this when the user asks 使用说明, 怎么用, okf 是否有使用说明, how to use, or example prompts.",
    parameters: {},
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute() {
      return okfHelp();
    },
    presentCall: () => present("OKF 使用说明", "read"),
  }));

  ctx.tools.register(defineTool({
    name: "okf_search",
    description:
      "Search this workspace OKF library (FTS, fused with semantic/vector hits after okf_sync_vectors). Hits are concept cards, not extract full text. Extract matches are returned as the linked Paper unless type=TextExtract. Optional from/to (published year or date range) and tags narrow the hits. Cite only ids from the result.",
    parameters: {
      query: { type: "string", required: true, description: "Full-text query" },
      type: { type: "string", description: "Optional OKF type filter, e.g. Paper, Claim, Topic, Method, Entity, Dataset, Gene, Pathway" },
      from: { type: "string", description: "Optional published year or date lower bound (e.g. 2022 or 2022-03)" },
      to: { type: "string", description: "Optional published year or date upper bound (e.g. 2024 or 2024-11)" },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional tags; every listed tag must be present on a hit",
      },
    },
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = openSession(pathsOf(getPaths, exec).okfDir);
      return searchOkf(session.store, args.query, asString(args.type), {
        from: asString(args.from),
        to: asString(args.to),
        tags: asStringArray(args.tags),
      });
    },
    presentCall: (args) => present("Search OKF", "search", args.query),
  }));

  ctx.tools.register(defineTool({
    name: "okf_sync_vectors",
    description:
      "Build or refresh the semantic (vector) index for this workspace, embedding extract and claim chunks with the configured model (KG_EMBED_MODEL / KG_EMBED_BASE_URL / KG_EMBED_API_KEY). After this, okf_search / okf_evidence / okf_graph query fuse semantic hits with full-text hits, so synonyms still match (e.g. 'breast cancer' finds pages about 'BRCA'). Idempotent and incremental; skip unless the user asks for 语义/同义词检索 or you need vector search.",
    parameters: {},
    output: jsonOutput,
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      const session = openSession(pathsOf(getPaths, exec).okfDir);
      return asJson(await syncVectorsOp(session.store));
    },
    presentCall: () => present("OKF sync vectors", "execute"),
  }));

  ctx.tools.register(defineTool({
    name: "okf_get",
    description:
      "Read one concept page (papers/…, claims/…, topics/…). Default body is capped. Do not use this on extracts/*.md — search already maps extract hits to papers. At most one or two calls per turn; full=true only for that one page.",
    parameters: {
      id: { type: "string", required: true, description: "Concept id or markdown path" },
      full: {
        type: "boolean",
        description: "Return the uncapped concept body (not extracts). Use at most once per turn.",
      },
    },
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = openSession(pathsOf(getPaths, exec).okfDir);
      return asJson(await getConcept(session.store, args.id, { full: args.full === true }));
    },
    presentCall: (args) => present("Read OKF page", "read", args.id),
  }));

  ctx.tools.register(defineTool({
    name: "okf_backlinks",
    description:
      "List who cites a concept: every node (papers, claims, topics, methods, entities, datasets, genes, pathways, notes) whose body links to the given id. Use this to answer 概念被谁引用, 哪些论文用了这个数据集/基因/通路, 谁引用了这篇论文. Reverse of the graph's outgoing edges, read from a cached index.",
    parameters: {
      id: { type: "string", required: true, description: "Concept id or markdown path" },
      type: { type: "string", description: "Optional OKF type filter for the citing nodes, e.g. Paper, Claim, Topic" },
    },
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = openSession(pathsOf(getPaths, exec).okfDir);
      return asJson(await backlinksOp(session.store, args.id, { type: asString(args.type) }));
    },
    presentCall: (args) => present("OKF backlinks", "search", args.id),
  }));

  ctx.tools.register(defineTool({
    name: "okf_coverage",
    description:
      "Topic × year coverage matrix plus per-topic Method/Dataset/Gene/Pathway usage and gaps for this workspace. Never asks the LLM to count papers.",
    parameters: {
      topic: { type: "string", description: "Optional topics/foo id or path" },
      from: { type: "string", description: "Published year or date lower bound" },
      to: { type: "string", description: "Published year or date upper bound" },
    },
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = openSession(pathsOf(getPaths, exec).okfDir);
      return asJson(await listCoverage(session.store, {
        topic: asString(args.topic),
        from: asString(args.from),
        to: asString(args.to),
      }));
    },
    presentCall: (args) => present("OKF coverage", "search", args.topic),
  }));

  ctx.tools.register(defineTool({
    name: "okf_graph",
    description:
      "Return a capped node/edge snapshot of this workspace library for the sidebar graph. Optional query focuses the subgraph. Optional id + depth expands the undirected neighborhood around one concept (multi-hop). Claims are omitted unless includeClaims, a query, or an id is set.",
    parameters: {
      query: { type: "string", description: "Optional FTS query to focus the subgraph" },
      id: { type: "string", description: "Optional concept id or markdown path to expand its neighborhood from" },
      depth: { type: "integer", description: "Neighborhood depth when id is set (1–3, default 1)" },
      includeClaims: { type: "boolean", description: "Include Claim nodes in a library overview (default false)" },
    },
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = openSession(pathsOf(getPaths, exec).okfDir);
      return libraryGraphOp(session.store, {
        query: asString(args.query),
        id: asString(args.id),
        depth: args.depth == null ? undefined : Number(args.depth),
        includeClaims: args.includeClaims === true,
      });
    },
    presentCall: (args) => present("OKF graph", "search", args.query ?? args.id),
  }));

  ctx.tools.register(defineTool({
    name: "okf_neighbors",
    description:
      "Direct neighbors of one concept, split into outgoing (links it makes) and incoming (who links to it), grouped by type. Use this for 这个概念的邻居, 它连接到哪些方法/数据集/基因, 谁直接引用了它. For multi-hop expansion use okf_graph with id + depth.",
    parameters: {
      id: { type: "string", required: true, description: "Concept id or markdown path" },
      type: { type: "string", description: "Optional OKF type filter for neighbors, e.g. Paper, Method, Dataset" },
    },
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = openSession(pathsOf(getPaths, exec).okfDir);
      return asJson(await neighborsOp(session.store, args.id, { type: asString(args.type) }));
    },
    presentCall: (args) => present("OKF neighbors", "search", args.id),
  }));

  ctx.tools.register(defineTool({
    name: "okf_compare",
    description:
      "Compare a bounded paper set: shared topics/methods/entities/datasets/genes/pathways/tags plus short cards. Pass papers ids and/or query. Do not call this on an unscoped 1000-paper library — use okf_stats first.",
    parameters: {
      papers: {
        type: "array",
        items: { type: "string" },
        description: "Optional papers/ ids or paths. Omit to compare the library (capped).",
      },
      query: { type: "string", description: "Optional FTS query to select papers when ids are omitted" },
    },
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = openSession(pathsOf(getPaths, exec).okfDir);
      return comparePapersOp(session.store, {
        papers: asStringArray(args.papers),
        query: asString(args.query),
      });
    },
    presentCall: (args) => present("Compare OKF papers", "search", args.papers),
  }));

  ctx.tools.register(defineTool({
    name: "okf_stats",
    description:
      "Library census: type counts, year histogram, and top topics/methods/entities/tags by paper degree. Use this first on a large library. Does not return paper bodies.",
    parameters: {},
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const session = openSession(pathsOf(getPaths, exec).okfDir);
      return libraryStatsOp(session.store);
    },
    presentCall: () => present("OKF library census", "search"),
  }));

  ctx.tools.register(defineTool({
    name: "okf_check",
    description:
      "Whole-library health audit. Reports dead internal links (markdown links whose target file does not exist), isolated papers (papers with zero edges to any other node — the lone-论文-node symptom), isolated concept nodes (Topic/Method/Entity/Dataset/Gene/Pathway pages with zero edges), unreferenced concept nodes (pages that link out but nothing links to them), and PDF pipeline completeness (ingest records not done, done papers whose file vanished, PDFs in sources/pdfs never ingested). Call this whenever the user asks 检查文库, 文库是否完整, 有没有断链, 孤立节点, 为什么某篇没有连线. Returns { ok, summary, issues }.",
    parameters: {},
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const session = openSession(pathsOf(getPaths, exec).okfDir);
      return libraryCheckOp(session.store);
    },
    presentCall: () => present("OKF library health check", "search"),
  }));

  ctx.tools.register(defineTool({
    name: "okf_evidence",
    description:
      "Gather top Claim pages for a question (the OKF citation atom). Returns claim titles, paper ids, and short excerpts — not paper bodies. Prefer this over okf_get when answering from the literature.",
    parameters: {
      query: { type: "string", required: true, description: "Question or keywords to match claims" },
    },
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = openSession(pathsOf(getPaths, exec).okfDir);
      return gatherEvidenceOp(session.store, args.query);
    },
    presentCall: (args) => present("Gather OKF claims", "search", args.query),
  }));

  ctx.tools.register(defineTool({
    name: "okf_paths",
    description:
      "Show the resolved OKF / PDF / export directories for this session workspace. Read-only; use okf_set_paths only if you must override the workspace layout.",
    parameters: {},
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const workspace = sessionCwd(exec) ?? null;
      return {
        workspace,
        ...pathsOf(getPaths, exec),
        layout: {
          okf: "OKF/ (papers/, topics/, …)",
          pdfs: "OKF/sources/pdfs/",
          manuscripts: "OKF/manuscripts/",
        },
      };
    },
    presentCall: () => present("OKF paths", "read"),
  }));

  ctx.tools.register(defineTool({
    name: "okf_set_paths",
    description:
      "Optional override: persist OKF / PDF / export directories in the harness user-settings document. Prefer the session workspace. Accepts ${cwd} ${workspace} ${home} ${dshHome} ${env:NAME}. Does not edit .env.",
    parameters: {
      okfDir: { type: "string", description: "OKF library folder; default is ${cwd}/OKF in the session workspace" },
      pdfDir: { type: "string", description: "Root for relative okf_ingest PDF paths" },
      exportDir: { type: "string", description: "Default okf_export / okf_pack destination" },
    },
    output: jsonOutput,
    async execute(args, exec) {
      const settings = ctx.get("settings");
      if (settings === undefined) {
        throw new Error(
          "okf_set_paths needs ctx.settings (dsh-settings). Set OKF_DIR / OKF_PDF_DIR / OKF_EXPORT_DIR in .env instead, or use the session workspace defaults.",
        );
      }
      const patch: Record<string, string> = {};
      const okfDir = asString(args.okfDir);
      const pdfDir = asString(args.pdfDir);
      const exportDir = asString(args.exportDir);
      if (okfDir) patch.okfDir = okfDir;
      if (pdfDir) patch.pdfDir = pdfDir;
      if (exportDir) patch.exportDir = exportDir;
      if (Object.keys(patch).length === 0) {
        throw new Error("okf_set_paths requires at least one of okfDir, pdfDir, exportDir");
      }
      await settings.update(OKF_SETTINGS_NS, patch);
      return pathsOf(getPaths, exec);
    },
    presentCall: (args) => present("Set OKF paths", "edit", args),
  }));

  ctx.tools.register(defineTool({
    name: "okf_save_note",
    description: "Write notes/*.md. Must link at least one Paper or Claim id from this folder.",
    parameters: {
      title: { type: "string", required: true },
      body: { type: "string", required: true },
      paperIds: { type: "array", items: { type: "string" }, description: "papers/… ids" },
      claimIds: { type: "array", items: { type: "string" }, description: "claims/… ids" },
    },
    output: jsonOutput,
    async execute(args, exec) {
      const session = openSession(pathsOf(getPaths, exec).okfDir);
      return saveNoteOp(session.store, {
        title: args.title,
        body: args.body,
        paperIds: asStringArray(args.paperIds),
        claimIds: asStringArray(args.claimIds),
      });
    },
    presentCall: (args) => present("Save OKF note", "edit", args.title),
  }));

  ctx.tools.register(defineTool({
    name: "okf_cite_check",
    description:
      "Verify that paper and claim markdown links in a survey draft exist in this OKF folder. Call before okf_save_survey.",
    parameters: {
      body: { type: "string", required: true, description: "Survey markdown body" },
    },
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = openSession(pathsOf(getPaths, exec).okfDir);
      return citeCheckOp(session.store, args.body);
    },
    presentCall: () => present("Cite-check survey", "search"),
  }));

  ctx.tools.register(defineTool({
    name: "okf_save_survey",
    description:
      "Write surveys/*.md from a human/model draft. Citations must already pass okf_cite_check. Does not call the LLM.",
    parameters: {
      title: { type: "string", required: true },
      body: { type: "string", required: true },
      path: { type: "string", description: "Optional surveys/foo.md" },
    },
    output: jsonOutput,
    async execute(args, exec) {
      const session = openSession(pathsOf(getPaths, exec).okfDir);
      return saveSurveyOp(session.store, {
        title: args.title,
        body: args.body,
        path: asString(args.path),
      });
    },
    presentCall: (args) => present("Save OKF survey", "edit", args.title),
  }));

  ctx.tools.register(defineTool({
    name: "okf_bib",
    description: "BibTeX for papers cited by a surveys/*.md page. Reuses stored bibliography; never invents DOIs.",
    parameters: {
      survey: { type: "string", required: true, description: "surveys/foo.md" },
    },
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = openSession(pathsOf(getPaths, exec).okfDir);
      return bibForSurvey(session.store, args.survey);
    },
    presentCall: (args) => present("Survey BibTeX", "read", args.survey),
  }));

  ctx.tools.register(defineTool({
    name: "okf_export",
    description:
      "Export a survey to Pandoc markdown or LaTeX plus a sidecar .bib under manuscripts/ by default. Never invents citations. Packs omit this folder.",
    parameters: {
      survey: { type: "string", required: true, description: "surveys/foo.md" },
      format: { type: "string", enum: ["md", "tex"], required: true },
      outDir: {
        type: "string",
        description: "Destination directory; default is manuscripts/ in the workspace.",
      },
    },
    output: jsonOutput,
    async execute(args, exec) {
      const paths = pathsOf(getPaths, exec);
      const session = openSession(paths.okfDir);
      const format = args.format === "tex" ? "latex" : "pandoc";
      const dest = asString(args.outDir);
      return exportSurveyOp(session.store, {
        survey: args.survey,
        format,
        outDir: dest ? resolveHostPath(dest, paths.exportDir) : paths.exportDir,
      });
    },
    presentCall: (args) => present("Export manuscript", "other", args.survey),
  }));

  ctx.tools.register(defineTool({
    name: "okf_pack",
    description:
      "Copy or zip a portable OKF pack from this workspace (concept markdown only). Excludes sources/pdfs/ and .okf/. Default destination is manuscripts/.",
    parameters: {
      out: {
        type: "string",
        description: "Folder or .zip path; relative paths resolve against manuscripts/. Default is a timestamped zip there.",
      },
      omitNotes: { type: "boolean", description: "Omit notes/*.md" },
      omitExtracts: { type: "boolean", description: "Omit extracts/*.md" },
    },
    output: jsonOutput,
    async execute(args, exec) {
      const paths = pathsOf(getPaths, exec);
      const session = openSession(paths.okfDir);
      const requested = asString(args.out) ?? path.join(paths.exportDir, `okf-pack-${packStamp()}.zip`);
      return packOkfOp(session.store, paths.okfDir, resolveHostPath(requested, paths.exportDir), {
        omitNotes: args.omitNotes === true,
        omitExtracts: args.omitExtracts === true,
      });
    },
    presentCall: (args) => present("Pack OKF", "other", args.out),
  }));

  ctx.tools.register(defineTool({
    name: "okf_merge",
    description:
      "Merge another OKF folder, unpacked pack, or knowledge-bundle.zip INTO this workspace's OKF/. Refuses merging a folder into itself. Rebuilds the index. Does not copy PDFs.",
    parameters: {
      from: {
        type: "string",
        required: true,
        description: "Source OKF folder, unpacked pack, or .zip; absolute, or relative to the workspace",
      },
    },
    output: jsonOutput,
    async execute(args, exec) {
      const paths = pathsOf(getPaths, exec);
      const workspace = sessionCwd(exec) ?? paths.okfDir;
      const session = openSession(paths.okfDir);
      const from = asString(args.from);
      if (!from) {
        throw new Error("okf_merge requires from");
      }
      return mergeOkfOp(session.store, paths.okfDir, resolveHostPath(from, workspace));
    },
    presentCall: (args) => present("Merge OKF", "edit", args.from),
  }));

  ctx.tools.register(defineTool({
    name: "okf_ingest",
    description:
      "Extract documents (pdf/docx/pptx/xlsx/epub/rtf/csv/md/…) into this workspace. PDFs: text layer via anydoc (Rust), figure/scan pages rasterized and sent to the harness multimodal model, then compile. Other formats convert straight to Markdown (no vision). PDFs whose anydoc text layer shows severe broken words (word-splitting like \"C opyright\") automatically route to full-document vision so the model re-reads pixels. Vision requests are small batches with timeout retries; a re-run resumes remaining pages. Default vision=\"auto\" runs full vision up to visionMaxPages (default 12) and pauses with awaiting_vision above that — then re-run with vision=all (full) / figures (figure pages only) / skip / pages:N,N,N. Long-running: defaults to a background job; read job_output.",
    parameters: {
      pdfs: {
        type: "array",
        required: true,
        items: { type: "string" },
        description: "Document paths: absolute, or relative to the sources dir (sources/pdfs for PDFs)",
      },
      compile: { type: "boolean", description: "Compile after extract (default true)" },
      vision: {
        type: "string",
        description:
          'Default "auto": run full vision up to visionMaxPages pages, above that pause with awaiting_vision and list choices. "all": full vision regardless of count. "figures": figure pages only. "skip": skip optional figure pages on born-digital PDFs (scans still need vision). "pages:N,N,N": explicit page subset.',
      },
      visionMaxPages: { type: "integer", description: "Pause budget for vision=auto (default 12)" },
      skipVision: { type: "boolean", description: "Legacy alias for vision=\"skip\"." },
      run_in_background: {
        type: "boolean",
        description: "Default true. Returns a job id; use job_output / job_kill.",
      },
    },
    output: jsonOutput,
    async execute(args, exec) {
      const paths = pathsOf(getPaths, exec);
      const jobArgs: IngestJobArgs = {
        pdfs: asStringArray(args.pdfs) ?? [],
        compile: args.compile,
        skipVision: args.skipVision,
        vision: asString(args.vision),
        visionMaxPages: typeof args.visionMaxPages === "number" ? args.visionMaxPages : undefined,
      };
      return asJson(await maybeBackground(
        ctx,
        exec,
        args.run_in_background,
        {
          kind: "okf-ingest",
          label: `okf_ingest ${jobArgs.pdfs.length} pdf(s)`,
          run: (log, signal) => runIngestJob(ctx, paths, jobArgs, log, signal),
        },
        async (signal) => {
          const log = new LineLog();
          const detail = await runIngestJob(ctx, paths, jobArgs, log, signal);
          return { kind: "foreground", detail, output: log.snapshot() };
        },
      ));
    },
    presentCall: (args) => present("Ingest PDFs", "execute", args.pdfs),
  }));

  ctx.tools.register(defineTool({
    name: "okf_compile",
    description:
      "Compile existing extracts/*.md into Paper / Topic / Method / Entity / Dataset / Claim using the harness default model (Gene / Pathway are opt-in via stages). Long-running; defaults to a background job. Omit paper to compile every extract (already-compiled papers with the current schema and unchanged extract are skipped, so reruns are cheap). paper may be a papers/ id, an extracts/*.md path, or a source filename (PDF or other) — extracts are named after the source file until compile writes paper:. Passing paper always forces a recompile of that target.",
    parameters: {
      paper: {
        type: "string",
        description: "Optional. papers/foo, extracts/foo.md, or a source filename (e.g. foo.pdf). Omit to compile all extracts.",
      },
      stages: {
        type: "array",
        items: { type: "string", enum: ["biblio", "concepts", "claims", "digest", "genes", "pathways"] },
        description:
          "Default: biblio|concepts|claims|digest. Genes and pathways are NOT extracted by default — include \"genes\" and/or \"pathways\" only when the user explicitly asks for gene/pathway extraction (e.g. [\"biblio\",\"concepts\",\"claims\",\"digest\",\"genes\",\"pathways\"], or just [\"genes\"] for an incremental gene-only pass).",
      },
      concurrency: { type: "integer", description: "Parallel extracts (default 2)" },
      run_in_background: { type: "boolean", description: "Default true" },
    },
    output: jsonOutput,
    async execute(args, exec) {
      const okfDir = pathsOf(getPaths, exec).okfDir;
      const jobArgs: CompileJobArgs = {
        paper: asString(args.paper),
        stages: asStringArray(args.stages),
        concurrency: typeof args.concurrency === "number" ? args.concurrency : undefined,
      };
      return asJson(await maybeBackground(
        ctx,
        exec,
        args.run_in_background,
        {
          kind: "okf-compile",
          label: `okf_compile ${jobArgs.paper ?? "all"}`,
          run: (log, signal) => runCompileJob(ctx, okfDir, jobArgs, log, signal),
        },
        async (signal) => {
          const log = new LineLog();
          const detail = await runCompileJob(ctx, okfDir, jobArgs, log, signal);
          return { kind: "foreground", detail, output: log.snapshot() };
        },
      ));
    },
    presentCall: (args) => present("Compile OKF", "execute", args.paper),
  }));

  ctx.tools.register(defineTool({
    name: "okf_compile_survey",
    description:
      "Background job: draft surveys/*.md with the harness default model. Prefer drafting yourself, then okf_cite_check and okf_save_survey.",
    parameters: {
      topic: { type: "string", required: true, description: "topics/foo id or path" },
      from: { type: "string" },
      to: { type: "string" },
      out: { type: "string", description: "Optional surveys/foo.md" },
      title: { type: "string" },
      run_in_background: { type: "boolean", description: "Default true" },
    },
    output: jsonOutput,
    async execute(args, exec) {
      const okfDir = pathsOf(getPaths, exec).okfDir;
      const jobArgs: SurveyJobArgs = {
        topic: args.topic,
        from: asString(args.from),
        to: asString(args.to),
        out: asString(args.out),
        title: asString(args.title),
      };
      return asJson(await maybeBackground(
        ctx,
        exec,
        args.run_in_background,
        {
          kind: "okf-survey",
          label: `okf_compile_survey ${jobArgs.topic}`,
          run: (log, signal) => runSurveyJob(ctx, okfDir, jobArgs, log, signal),
        },
        async (signal) => {
          const log = new LineLog();
          const detail = await runSurveyJob(ctx, okfDir, jobArgs, log, signal);
          return { kind: "foreground", detail, output: log.snapshot() };
        },
      ));
    },
    presentCall: (args) => present("Compile survey", "execute", args.topic),
  }));
}
