import { NodeFileStore } from "@/lib/fs/node";
import type { FileStore } from "@/lib/fs/types";
import { resolveOkfDir } from "./paths";

export type PluginSession = {
  okfDir: string;
  store: FileStore;
};

export function openSession(okfDir: string): PluginSession {
  const resolved = resolveOkfDir(okfDir);
  return { okfDir: resolved, store: new NodeFileStore(resolved) };
}
