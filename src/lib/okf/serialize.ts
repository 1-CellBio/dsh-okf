import { stringify as stringifyYaml } from "yaml";
import type { Frontmatter } from "@/types/okf";

export function serializeDocument(frontmatter: Frontmatter, body: string): string {
  const yaml = stringifyYaml(frontmatter).trimEnd();
  const trimmedBody = body.replace(/^\n+/, "");
  return `---\n${yaml}\n---\n${trimmedBody.length ? `${trimmedBody}\n` : ""}`;
}
