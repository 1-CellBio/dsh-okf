import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { generatedBy } from "@/lib/okf/generated";
import { conceptPath, toConceptId } from "@/lib/okf/links";
import { parseDocument } from "@/lib/okf/parse";
import { serializeDocument } from "@/lib/okf/serialize";
import { conceptSlug } from "@/lib/okf/slug";
import type { Frontmatter } from "@/types/okf";

export type WriteNoteInput = {
  title: string;
  body: string;
  paperIds?: string[];
  claimIds?: string[];
  at?: string;
  path?: string;
};

function linkLine(id: string): string {
  const concept = toConceptId(id);
  return `- [${concept}](/${conceptPath(concept)})`;
}

function notePath(inputPath: string | undefined, title: string): string {
  if (!inputPath?.trim()) {
    return `notes/${conceptSlug(title)}.md`;
  }
  const raw = inputPath.trim().replace(/^\/+/, "").replace(/\\/g, "/");
  const segments = raw.split("/");
  if (segments.includes("..") || segments.includes(".") || segments.some((segment) => !segment)) {
    throw new Error(`Refusing note path with path traversal: ${inputPath}`);
  }
  if (!raw.endsWith(".md")) {
    throw new Error(`Note path must end with .md: ${inputPath}`);
  }
  return raw;
}

export async function writeNote(store: FileStore, input: WriteNoteInput): Promise<string> {
  const title = input.title.trim() || "Untitled note";
  const papers = [...new Set((input.paperIds ?? []).map((id) => toConceptId(id)))];
  const claims = [...new Set((input.claimIds ?? []).map((id) => toConceptId(id)))];
  if (papers.length === 0 && claims.length === 0) {
    throw new Error("A Note must link at least one Paper or Claim");
  }
  const path = notePath(input.path, title);
  const links = [...papers, ...claims].map(linkLine).join("\n");
  const body = `${input.body.trim()}\n\n## Sources\n\n${links}\n`;
  const frontmatter: Frontmatter = {
    type: "Note",
    title,
    status: "draft",
    generated: { by: generatedBy("note"), at: input.at ?? new Date().toISOString() },
  };
  if (await store.exists(path)) {
    const existing = parseDocument(utf8Decode(await store.read(path)));
    await store.write(
      path,
      serializeDocument({ ...existing.frontmatter, title, type: "Note" }, body),
    );
    return path;
  }
  await store.write(path, serializeDocument(frontmatter, body));
  return path;
}
