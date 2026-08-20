import os from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";

const TOKEN_RE = /\$\{([^}]+)\}/g;

/** Launch-directory fallback when a tool has no session workspace. */
export const DEFAULT_TEMPLATE = "${cwd}";

/** Session workspace contains OKF/ as the library. */
export const DEFAULT_OKF_DIR = "${cwd}/OKF";
/** Spec layout: original PDFs live under the library, local-only. */
export const DEFAULT_PDF_DIR = "${okfDir}/sources/pdfs";
/** Manuscripts stay in the workspace but are not a concept prefix (packs omit them). */
export const DEFAULT_EXPORT_DIR = "${okfDir}/manuscripts";

export type PluginPaths = {
  okfDir: string;
  pdfDir: string;
  exportDir: string;
};

export type PathConfig = {
  okfDir?: string;
  pdfDir?: string;
  exportDir?: string;
};

export function defaultDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_HOME?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.join(os.homedir(), ".dsh");
}

/**
 * Session workspace folder from a tool execution context.
 * Falls back to undefined when there is no agent (tests / headless).
 */
export function sessionCwd(exec?: {
  agent?: { session?: { header?: { cwd?: string } } };
}): string | undefined {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd.trim() ? cwd.trim() : undefined;
}

export function expandPathTemplate(raw: string, vars: Record<string, string>, env: NodeJS.ProcessEnv = process.env): string {
  return raw.replace(TOKEN_RE, (full, token: string) => {
    if (token.startsWith("env:")) {
      const name = token.slice("env:".length);
      const value = env[name]?.trim();
      if (!value) {
        throw new Error(`path variable ${full} is empty (${name} is unset)`);
      }
      return value;
    }
    const value = vars[token];
    if (value === undefined) {
      throw new Error(
        `unknown path variable ${full} (use cwd, workspace, home, dshHome, okfDir, pdfDir, exportDir, or env:NAME)`,
      );
    }
    return value;
  });
}

export function resolveOkfDir(raw: string, cwd?: string): string {
  if (!raw.trim()) {
    throw new Error("okfDir is required");
  }
  return resolvePluginPaths({ okfDir: raw }, process.env, cwd).okfDir;
}

export function resolvePluginPaths(
  config: PathConfig,
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): PluginPaths {
  const workspace = (cwd && cwd.trim()) || process.cwd();
  const home = os.homedir();
  const dshHome = defaultDshHome(env);
  const vars: Record<string, string> = {
    cwd: workspace,
    workspace,
    home,
    dshHome,
    okfDir: workspace,
    pdfDir: workspace,
    exportDir: workspace,
  };

  const okfDir = resolveOne(config.okfDir, env.OKF_DIR, vars, env, DEFAULT_OKF_DIR);
  vars.okfDir = okfDir;
  const pdfDir = resolveOne(config.pdfDir, env.OKF_PDF_DIR, vars, env, DEFAULT_PDF_DIR);
  vars.pdfDir = pdfDir;
  const exportDir = resolveOne(config.exportDir, env.OKF_EXPORT_DIR, vars, env, DEFAULT_EXPORT_DIR);
  vars.exportDir = exportDir;

  return { okfDir, pdfDir, exportDir };
}

export function resolveHostPath(raw: string, root: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("path is required");
  }
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(root, trimmed);
}

export function surveyStorePath(raw: string): string {
  const value = raw.trim().replace(/^\/+/, "");
  if (!value) {
    throw new Error("survey path is required");
  }
  if (value.startsWith("surveys/") && value.endsWith(".md") && !value.slice("surveys/".length).includes("/")) {
    return value;
  }
  if (value.endsWith(".md") && !value.includes("/")) {
    return `surveys/${value}`;
  }
  throw new Error(`survey path must be surveys/*.md, got ${JSON.stringify(raw)}`);
}

export async function sameResolvedPath(left: string, right: string): Promise<boolean> {
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (a === b) {
    return true;
  }
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}

function resolveOne(
  configured: string | undefined,
  envValue: string | undefined,
  vars: Record<string, string>,
  env: NodeJS.ProcessEnv,
  schemaDefault: string,
): string {
  const cfg = configured?.trim();
  const fromEnv = envValue?.trim();
  const isDefault = !cfg || cfg === DEFAULT_TEMPLATE || cfg === schemaDefault;
  const template = !isDefault ? cfg : fromEnv || cfg || schemaDefault;
  const expanded = expandPathTemplate(template, vars, env).trim();
  if (!expanded) {
    throw new Error("dsh-okf path is empty after expanding variables");
  }
  return path.resolve(expanded);
}
