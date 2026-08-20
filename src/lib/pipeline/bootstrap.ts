import type { FileStore } from "@/lib/fs/types";
import { gitignoreOkfCache } from "@/lib/okf/cache";
import { AGENTS_PROTOCOL } from "./agentsTemplate";

const EMPTY_INDEX = `---
type: Index
title: Knowledge bundle
---

# Knowledge bundle

This folder is an OKF knowledge base. Prefer \`papers/\`, \`topics/\`, \`methods/\`, \`entities/\`, \`datasets/\`, \`genes/\`, and \`pathways/\` over \`extracts/\`.
Cite concepts by path. Do not invent Paper ids.

Empty bundle. Import PDFs to compile concepts.
`;

export async function bootstrapBundle(store: FileStore): Promise<void> {
  if (!(await store.exists("index.md"))) {
    await store.write("index.md", EMPTY_INDEX);
  }
  if (!(await store.exists("log.md"))) {
    await store.write("log.md", "# Log\n\n");
  }
  if (!(await store.exists("AGENTS.md"))) {
    await store.write("AGENTS.md", AGENTS_PROTOCOL);
  }
  if (!(await store.exists(".gitignore"))) {
    await store.write(".gitignore", gitignoreOkfCache());
  }
}
