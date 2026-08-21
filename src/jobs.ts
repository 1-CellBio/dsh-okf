import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { JobOutcome } from "@deepseek-ai/dsh-jobs";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { createBiblioClientFromEnv } from "@/lib/biblio/client";
import { readBiblioFrontmatter } from "@/lib/biblio/apply";
import { ALL_COMPILE_STAGES, OPTIONAL_COMPILE_STAGES, type CompileStage } from "@/lib/compile/run";
import { compileTargets } from "@/lib/compile/fromStore";
import { TextExtractor } from "@/lib/extractors/text";
import { AnyDocEngine, supportedFormats } from "@/lib/doc/anydocEngine";
import { expandSourcePaths } from "@/lib/pipeline/expandSources";
import { INGEST_CONCURRENCY, runPipeline, type PdfInput, type VisionMode } from "@/lib/pipeline/run";
import { readFile } from "node:fs/promises";
import "./kinds";
import { harnessChatClient, requireHarnessModel } from "./llm-client";
import type { ChatClient } from "@/lib/providers/types";
import { LineLog } from "./log-buffer";
import { consolidateHubs } from "@/lib/compile/consolidate";
import { aliasConsolidateHubs } from "@/lib/compile/aliasPass";
import { pruneUnquotedClaims } from "@/lib/compile/pruneClaims";
import { compileSurveyOp, invalidateBundleIndex, syncVectorsOp } from "./okf-ops";
import { type PluginPaths } from "./paths";
import { openSession } from "./session";
import { asString, displayDoi } from "@/lib/okf/identity";
import { parseDocument } from "@/lib/okf/parse";
import { utf8Decode } from "@/lib/fs/types";

export type IngestJobArgs = {
  pdfs: string[];
  compile?: boolean;
  /** Legacy alias for vision="skip". */
  skipVision?: boolean;
  /** Vision policy: auto (default) | all | figures | skip | "pages:N,N,N". */
  vision?: string;
  /** Optional pause budget for vision="auto". Unset = transcribe every planned page. */
  visionMaxPages?: number;
  /** Parallel documents (default 3). */
  concurrency?: number;
};

export type CompileJobArgs = {
  paper?: string;
  stages?: string[];
  concurrency?: number;
};

export type SurveyJobArgs = {
  topic: string;
  from?: string;
  to?: string;
  out?: string;
  title?: string;
};

export function startOkfJob(
  ctx: Context,
  exec: ToolRunContext,
  spec: {
    kind: "okf-ingest" | "okf-compile" | "okf-survey";
    label: string;
    run: (log: LineLog, signal: AbortSignal) => Promise<string>;
  },
): { kind: "background"; jobId: string } {
  const jobs = ctx.get("jobs");
  if (jobs === undefined) {
    throw new Error("background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs");
  }
  const id = jobs.start({
    kind: spec.kind,
    label: spec.label,
    ...(exec.agent ? { owner: exec.agent as Agent } : {}),
    run: () => {
      const log = new LineLog();
      const controller = new AbortController();
      const done = spec.run(log, controller.signal).then(
        (detail): JobOutcome => ({ status: "completed", detail }),
        (error: unknown): JobOutcome => {
          if (controller.signal.aborted) {
            return { status: "killed", detail: "aborted" };
          }
          const message = error instanceof Error ? error.message : String(error);
          log.append(`error: ${message}`);
          return { status: "failed", detail: message };
        },
      );
      return {
        cancel: () => controller.abort(),
        done,
        readOutput: () => log.readOutput(),
      };
    },
  });
  return { kind: "background", jobId: id };
}

export async function runIngestJob(
  ctx: Context,
  paths: PluginPaths,
  args: IngestJobArgs,
  log: LineLog,
  signal: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const pdfs = args.pdfs.map((item) => item.trim()).filter(Boolean);
  if (pdfs.length === 0) {
    throw new Error("okf_ingest requires pdfs");
  }
  const session = openSession(paths.okfDir);
  const expanded = await expandSourcePaths(pdfs, paths.pdfDir);
  for (const warning of expanded.warnings) {
    log.append(warning);
  }
  if (expanded.files.length === 0) {
    throw new Error(
      `okf_ingest: no supported documents under ${JSON.stringify(pdfs)} (supported: ${supportedFormats()})`,
    );
  }
  const inputs: PdfInput[] = [];
  for (const file of expanded.files) {
    log.append(`read ${file.full}`);
    const bytes = new Uint8Array(await readFile(file.full));
    inputs.push({ filename: file.filename, bytes });
  }
  const compile = args.compile !== false;
  const visionMode = parseVision(args.vision, args.skipVision);
  const engine = new AnyDocEngine();
  const client = compile
    ? harnessChatClient(ctx, signal)
    : {
        async complete() {
          throw new Error("internal: okf_ingest compile=false must not call the LLM");
        },
      };
  const model = compile ? requireHarnessModel(ctx).model : "none";
  const concurrency = args.concurrency ?? INGEST_CONCURRENCY;
  log.append(
    `extract ${inputs.length} document(s) compile=${compile} vision=${describeVision(visionMode)} maxPages=${args.visionMaxPages ?? "none"} concurrency=${concurrency} engine=anydoc+pdfjs`,
  );
  const results = await runPipeline(session.store, inputs, {
    extractor: new TextExtractor(engine),
    client,
    model,
    compile,
    vision: { mode: visionMode, maxPages: args.visionMaxPages },
    raster: (pdf, page, opts) => engine.rasterPage(pdf, page, opts),
    biblio: createBiblioClientFromEnv(),
    onLog: (line) => log.append(line),
    concurrency,
  });
  throwIfAborted(signal);
  invalidateBundleIndex(session.store);
  for (const result of results) {
    log.append(`${result.path} ${result.status}${result.skipped ? " skipped" : ""}`);
  }
  const vision = results.filter((item) => item.status === "needs_vision" || item.status === "awaiting_vision");
  if (vision.length > 0) {
    log.append(
      `${vision.length} document(s) still need vision (raster or multimodal complete failed). Check job_output; retry okf_ingest.`,
    );
  }
  await finishHubsAndIndex(session.store, log, compile ? client : undefined);
  await maybeSyncVectors(session.store, log);
  return `ingest ${results.length} document(s)`;
}

export async function runCompileJob(
  ctx: Context,
  okfDir: string,
  args: CompileJobArgs,
  log: LineLog,
  signal: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const session = openSession(okfDir);
  const stages = parseStages(args.stages);
  const model = requireHarnessModel(ctx).model;
  log.append(`compile stages=${stages.join(",")} paper=${args.paper ?? "*"}`);
  const compileClient = harnessChatClient(ctx, signal);
  const { results, failures } = await compileTargets(
    session.store,
    compileClient,
    {
      model,
      stages,
      biblio: createBiblioClientFromEnv(),
      onLog: (line) => log.append(line),
    },
    args.paper?.trim() || undefined,
    args.concurrency,
  );
  throwIfAborted(signal);
  await finishHubsAndIndex(session.store, log, compileClient);
  const upToDate = results.filter((result) => result.alreadyCompiled).length;
  for (const result of results) {
    log.append(
      result.alreadyCompiled
        ? `${result.paperPath} already compiled (schema up to date, extract unchanged)`
        : `${result.paperPath} wrote=${result.written.length}`,
    );
  }
  for (const failure of failures) {
    log.append(`compile failed: ${failure.path}: ${failure.message}`);
  }
  await maybeSyncVectors(session.store, log);
  return `compile ${results.length} extract(s)${upToDate > 0 ? ` (${upToDate} already up to date, skipped)` : ""}`;
}

export async function runSurveyJob(
  ctx: Context,
  okfDir: string,
  args: SurveyJobArgs,
  log: LineLog,
  signal: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const session = openSession(okfDir);
  const model = requireHarnessModel(ctx).model;
  log.append(`compile survey topic=${args.topic}`);
  const result = (await compileSurveyOp(session.store, harnessChatClient(ctx, signal), model, args)) as {
    path: string;
    cited: string[];
    illegal: string[];
  };
  throwIfAborted(signal);
  log.append(`wrote ${result.path} cited=${result.cited.length} illegal=${result.illegal.length}`);
  invalidateBundleIndex(session.store);
  return `survey ${result.path}`;
}

function parseStages(raw: string[] | undefined): CompileStage[] {
  if (!raw || raw.length === 0) {
    return [...ALL_COMPILE_STAGES];
  }
  const allowed = new Set<string>([...ALL_COMPILE_STAGES, ...OPTIONAL_COMPILE_STAGES]);
  const stages: CompileStage[] = [];
  for (const item of raw) {
    const stage = item.trim();
    if (!allowed.has(stage)) {
      throw new Error(
        `unknown compile stage ${JSON.stringify(item)} (expected biblio|concepts|claims|digest, optionally genes and/or pathways)`,
      );
    }
    stages.push(stage as CompileStage);
  }
  return stages;
}

function parseVision(raw: string | undefined, skipVision: boolean | undefined): VisionMode {
  if (skipVision === true) {
    return "skip";
  }
  const value = (raw ?? "auto").trim();
  if (value === "auto" || value === "all" || value === "figures" || value === "skip") {
    return value;
  }
  if (value.startsWith("pages:")) {
    const pages = value
      .slice("pages:".length)
      .split(",")
      .map((item) => Number(item.trim()))
      .filter((page) => Number.isInteger(page) && page > 0);
    return { pages };
  }
  throw new Error(`okf_ingest: invalid vision=${JSON.stringify(value)} (expected auto|all|figures|skip|pages:N,N,N)`);
}

function describeVision(mode: VisionMode): string {
  return typeof mode === "object" ? `pages:${mode.pages.join(",")}` : mode;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  }
}

async function maybeSyncVectors(store: ReturnType<typeof openSession>["store"], log: LineLog): Promise<void> {
  try {
    const result = await syncVectorsOp(store);
    log.append(`vectors model=${result.model} chunks=${result.chunks} changed=${result.changed}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no embedding model/i.test(message)) {
      return;
    }
    log.append(`vectors skipped: ${message}`);
  }
}

async function finishHubsAndIndex(
  store: ReturnType<typeof openSession>["store"],
  log: LineLog,
  client?: ChatClient,
): Promise<void> {
  const pruned = await pruneUnquotedClaims(store);
  if (pruned.pruned > 0 || pruned.healed > 0) {
    log.append(`claims prune dropped=${pruned.pruned} healed=${pruned.healed} kept=${pruned.kept}`);
  }
  const merges = await consolidateHubs(store, undefined, { onLog: (line) => log.append(line) });
  if (merges.length > 0) {
    log.append(`consolidated ${merges.length} hub pair(s)`);
  }
  if (client) {
    const aliasMerges = await aliasConsolidateHubs(store, client, undefined, {
      onLog: (line) => log.append(line),
    });
    if (aliasMerges.length > 0) {
      log.append(`alias consolidated ${aliasMerges.length} hub pair(s)`);
    }
  }
  await logBiblioGaps(store, log);
  invalidateBundleIndex(store);
}

async function logBiblioGaps(
  store: ReturnType<typeof openSession>["store"],
  log: LineLog,
): Promise<void> {
  const paths = (await store.list("papers/")).filter((path) => path.endsWith(".md"));
  let missingPublished = 0;
  let missingDoi = 0;
  let suggested = 0;
  for (const path of paths) {
    const { frontmatter } = parseDocument(utf8Decode(await store.read(path)));
    if (asString(frontmatter.status) === "deprecated") {
      continue;
    }
    if (!asString(frontmatter.published)) {
      missingPublished += 1;
    }
    if (!displayDoi(frontmatter.doi)) {
      missingDoi += 1;
    }
    if (readBiblioFrontmatter(frontmatter.biblio)?.status === "suggested") {
      suggested += 1;
    }
  }
  if (missingPublished === 0 && missingDoi === 0 && suggested === 0) {
    return;
  }
  log.append(
    `biblio gaps missing_published=${missingPublished} missing_doi=${missingDoi} low_confidence=${suggested} (open the review tab)`,
  );
}
