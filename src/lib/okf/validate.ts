import type { Frontmatter } from "@/types/okf";

export function isReservedFilename(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return base === "index.md" || base === "log.md" || base === "AGENTS.md";
}

export function validateConcept(frontmatter: Frontmatter, path: string): string[] {
  const errors: string[] = [];
  if (isReservedFilename(path)) {
    errors.push("reserved filename");
  }
  if (typeof frontmatter.type !== "string" || frontmatter.type.trim() === "") {
    errors.push("type is required");
  }
  return errors;
}

export function isHumanVerified(frontmatter: Frontmatter): boolean {
  const raw = frontmatter.verified;
  if (raw == null) {
    return false;
  }
  const events = Array.isArray(raw) ? raw : [raw];
  return events.some(
    (event) =>
      typeof event === "object" &&
      event !== null &&
      "by" in event &&
      typeof (event as { by: unknown }).by === "string" &&
      (event as { by: string }).by.startsWith("human:"),
  );
}
