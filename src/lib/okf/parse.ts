import { parse as parseYaml } from "yaml";
import type { Frontmatter, ParsedDocument } from "@/types/okf";

export function parseDocument(raw: string): ParsedDocument {
  if (!raw.startsWith("---")) {
    return { frontmatter: {}, body: raw };
  }
  const afterOpen = raw.slice(3);
  const close = afterOpen.search(/\n---(?:\n|$)/);
  if (close === -1) {
    return { frontmatter: {}, body: raw };
  }
  const yamlText = afterOpen.slice(0, close).replace(/^\r?\n/, "");
  const remainder = afterOpen.slice(close).replace(/^\n---/, "");
  const body = remainder.replace(/^\r?\n/, "");
  const parsed: unknown = parseYaml(yamlText);
  const frontmatter: Frontmatter =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Frontmatter)
      : {};
  return { frontmatter, body };
}
