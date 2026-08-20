import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { JobOutcome } from "@deepseek-ai/dsh-jobs";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { createBiblioClientFromEnv } from "@/lib/biblio/client";
import { ALL_COMPILE_STAGES, OPTIONAL_COMPILE_STAGES, type CompileStage } from "@/lib/compile/run";
import { compileTargets } from "@/lib/compile/fromStore";
import { TextExtractor } from "@/lib/extractors/text";
import { AnyDocEngine, isSupportedSource, supportedFormats } from "@/lib/doc/anydocEngine";
import { runPipeline, type PdfInput, type VisionMode } from "@/lib/pipeline/run";
import { VISION_PAUSE_DEFAULT } from "@/lib/extractors/visionGate";
import { readFile } from "node:fs/promises";
import path from "node:path";
import "./kinds";
import { harnessChatClient, requireHarnessModel } from "./llm-client";
import { LineLog } from "./log-buffer";
import { compileSurveyOp } from "./okf-ops";
import { resolveHostPath, type PluginPaths } from "./paths";
import { openSession } from "./session";

export type IngestJobArgs = {
  pdfs: string[];
  compile?: boolean;
  /** Legacy alias for vision="skip". */
  skipVision?: boolean;
  /** Vision policy: auto (default) | all | figures | skip | "pages:N,N,N". */
  vision?: string;
  /** Pause budget for vision="auto". Default VISION_PAUSE_DEFAULT (12). */
  visionMaxPages?: number;
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
  const inputs: PdfInput[] = [];
  for (const raw of pdfs) {
    const full = resolveHostPath(raw, paths.pdfDir);
    const filename = path.basename(full);
    if (!isSupportedSource(filename)) {
      throw new Error(
        `okf_ingest: unsupported format ${JSON.stringify(filename)} (supported: ${supportedFormats()})`,
      );
    }
    log.append(`read ${full}`);
    const bytes = new Uint8Array(await readFile(full));
    inputs.push({ filename, bytes });
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
  log.append(`extract ${inputs.length} document(s) compile=${compile} vision=${describeVision(visionMode)} maxPages=${args.visionMaxPages ?? VISION_PAUSE_DEFAULT} engine=anydoc+pdfjs`);
  const results = await runPipeline(session.store, inputs, {
    extractor: new TextExtractor(engine),
    client,
    model,
    compile,
    vision: { mode: visionMode, maxPages: args.visionMaxPages ?? VISION_PAUSE_DEFAULT },
    raster: (pdf, page, opts) => engine.rasterPage(pdf, page, opts),
    biblio: createBiblioClientFromEnv(),
    onLog: (line) => log.append(line),
  });
  throwIfAborted(signal);
  for (const result of results) {
    log.append(`${result.path} ${result.status}${result.skipped ? " skipped" : ""}`);
  }
  const vision = results.filter((item) => item.status === "needs_vision" || item.status === "awaiting_vision");
  if (vision.length > 0) {
    log.append(
      `${vision.length} document(s) still need vision (raster or multimodal complete failed). Check job_output; retry okf_ingest.`,
    );
  }
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
  const { results, failures } = await compileTargets(
    session.store,
    harnessChatClient(ctx, signal),
    {
      model,
      stages,
      biblio: createBiblioClientFromEnv(),
    },
    args.paper?.trim() || undefined,
    args.concurrency,
  );
  throwIfAborted(signal);
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
