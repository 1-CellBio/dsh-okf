import type { FileStore } from "@/lib/fs/types";
import { serializeDocument } from "@/lib/okf/serialize";
import type { Frontmatter } from "@/types/okf";

export const LOCAL_HUMAN_ACTOR = "human:local";

export function applyHumanVerified(
  frontmatter: Frontmatter,
  at = new Date().toISOString(),
): Frontmatter {
  return {
    ...frontmatter,
    verified: { by: LOCAL_HUMAN_ACTOR, at },
    status: "stable",
  };
}

export async function writeConceptDocument(
  store: FileStore,
  path: string,
  frontmatter: Frontmatter,
  body: string,
): Promise<void> {
  await store.write(path, serializeDocument(frontmatter, body));
}
