import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { DEFAULT_EXPORT_DIR, DEFAULT_OKF_DIR, DEFAULT_PDF_DIR } from "./paths";
import { installPathSettings } from "./settings";
import { registerTools } from "./tools";
import { installLibraryHttp } from "./library-http";
import "./kinds";

export const name = "dsh-okf";
export const inject = ["tools", "systemPrompt"];

export interface Config {
  /** OKF library. Default ${cwd}/OKF under the session workspace. Override with OKF_DIR. */
  okfDir?: string;
  /** Root for relative okf_ingest PDF paths. Default ${okfDir}/sources/pdfs. */
  pdfDir?: string;
  /** Default okf_export / okf_pack directory. Default ${okfDir}/manuscripts. */
  exportDir?: string;
}

export const Config: z<Config> = z.object({
  okfDir: z.string().default(DEFAULT_OKF_DIR),
  pdfDir: z.string().default(DEFAULT_PDF_DIR),
  exportDir: z.string().default(DEFAULT_EXPORT_DIR),
});

export function apply(ctx: Context, config: Config): void {
  const getPaths = installPathSettings(ctx, Config, config);
  registerTools(ctx, getPaths);
  installLibraryHttp(ctx, getPaths);
}
