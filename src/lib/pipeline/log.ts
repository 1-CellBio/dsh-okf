import { withPathLock } from "@/lib/fs/pathLock";
import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { extractLinks } from "@/lib/okf/links";
import { parseDocument } from "@/lib/okf/parse";
import { mapPool } from "@/lib/pipeline/pool";

const TOP_TOPIC_LIMIT = 12;

function markdownFiles(paths: string[]): string[] {
  return paths.filter((path) => path.endsWith(".md") && !path.endsWith("index.md"));
}

async function countPaperLinks(store: FileStore, path: string): Promise<number> {
  const { body } = parseDocument(utf8Decode(await store.read(path)));
  return extractLinks(body, path).filter((id) => id.startsWith("papers/")).length;
}

export async function appendLog(store: FileStore, line: string): Promise<void> {
  const path = "log.md";
  await withPathLock(path, async () => {
    const stamp = new Date().toISOString();
    if (store.append) {
      // log.md is machine-written (bootstrap + this function) and always ends
      // with a newline, so appending matches the read-modify-write format
      // without rewriting a growing file on every log line.
      const first = !(await store.exists(path));
      await store.append(path, first ? `# Log\n\n- ${stamp} ${line}\n` : `- ${stamp} ${line}\n`);
      return;
    }
    const prev = (await store.exists(path)) ? utf8Decode(await store.read(path)) : "# Log\n\n";
    await store.write(path, `${prev.trimEnd()}\n- ${stamp} ${line}\n`);
  });
}

export async function refreshRootIndex(store: FileStore): Promise<void> {
  const papers = markdownFiles(await store.list("papers/"));
  const topics = markdownFiles(await store.list("topics/"));
  const methods = markdownFiles(await store.list("methods/"));
  const entities = markdownFiles(await store.list("entities/"));
  const datasets = markdownFiles(await store.list("datasets/"));
  const genes = markdownFiles(await store.list("genes/"));
  const pathways = markdownFiles(await store.list("pathways/"));
  const claims = markdownFiles(await store.list("claims/"));
  const notes = markdownFiles(await store.list("notes/"));
  const questions = markdownFiles(await store.list("questions/"));
  const surveys = markdownFiles(await store.list("surveys/"));

  // Rank topics with a bounded pool: counting links reads every topic page,
  // and a serial loop was O(topics) sequential file reads after every
  // pipeline run. mapPool preserves path order for the stable sort below.
  const counts = await mapPool(topics, 8, (path) => countPaperLinks(store, path));
  const ranked: { path: string; count: number }[] = topics.map((path, index) => ({ path, count: counts[index] ?? 0 }));
  ranked.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  const topTopics = ranked.slice(0, TOP_TOPIC_LIMIT);

  const lines = [
    "---",
    "type: Index",
    "title: Knowledge bundle",
    "---",
    "",
    "# Knowledge bundle",
    "",
    "This folder is an OKF knowledge base. Prefer `papers/`, `topics/`, `methods/`, `entities/`, `datasets/`, `genes/`, `pathways/`, `claims/`, `notes/`, `questions/`, and `surveys/` over `extracts/`.",
    "Cite concepts by path (for example `papers/2017-attention-is-all-you-need` or `claims/...`). Do not invent Paper or Claim ids.",
    "",
    "## How to read",
    "",
    "- Start here, then open a topic or paper. Full lists live in those directories — this file is not a catalog dump.",
    "- Do not read `extracts/` end-to-end; they are a search corpus.",
    "- `published` is scientific time, not file mtime. Do not overwrite `verified.by: human:*` pages.",
    "",
    "## Counts",
    "",
    `- Papers: ${papers.length}`,
    `- Topics: ${topics.length}`,
    `- Methods: ${methods.length}`,
    `- Entities: ${entities.length}`,
    `- Datasets: ${datasets.length}`,
    `- Genes: ${genes.length}`,
    `- Pathways: ${pathways.length}`,
    `- Claims: ${claims.length}`,
    `- Notes: ${notes.length}`,
    `- Questions: ${questions.length}`,
    `- Surveys: ${surveys.length}`,
    "",
    "## Top topics",
    "",
    ...(topTopics.length > 0
      ? topTopics.map(({ path, count }) => `- [${path}](/${path}) (${count} papers)`)
      : ["- None yet."]),
    "",
  ];
  const next = lines.join("\n");
  if (await store.exists("index.md")) {
    const prev = utf8Decode(await store.read("index.md")).replace(/\s+$/u, "");
    if (prev === next.replace(/\s+$/u, "")) {
      return;
    }
  }
  await store.write("index.md", next);
}
