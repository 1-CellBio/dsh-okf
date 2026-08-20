import type { Context } from "@deepseek-ai/cordis";
import type z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import type {} from "@deepseek-ai/dsh-system-prompt";
import { resolvePluginPaths, type PathConfig, type PluginPaths } from "./paths";
import { okfPrompt } from "./prompt";

export const OKF_SETTINGS_NS = settingsNamespace("okf");

/** Resolve OKF / PDF / export paths for a session workspace (`cwd`). */
export type PathSource = (cwd?: string) => PluginPaths;

/**
 * Bind composition config, then the user-settings document when `ctx.settings`
 * exists. Tools read through the returned getter so a saved settings change
 * takes effect without restart. Pass the session workspace as `cwd`.
 */
export function installPathSettings<T extends PathConfig>(
  ctx: Context,
  schema: z<T>,
  entry: T,
): PathSource {
  let source: () => T = () => entry;
  const pathsOf: PathSource = (cwd) => resolvePluginPaths(source(), process.env, cwd);

  let disposePrompt = (): void => {};
  const publishPrompt = (): void => {
    disposePrompt();
    disposePrompt = ctx.systemPrompt.section({
      name: "plugin:okf",
      order: 118,
      text: okfPrompt(),
    });
  };
  publishPrompt();

  installSettingsSection(ctx, OKF_SETTINGS_NS, schema, entry, {
    setSource: (current) => {
      source = current;
    },
    onChange: publishPrompt,
  });

  return pathsOf;
}
