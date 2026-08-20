const CONCEPT_HREF =
  /^(?:\/)?((?:papers|topics|methods|entities|claims|notes|questions|surveys|extracts)\/[^\s#]+)$/i;

/** Drop a leading ATX h1 that repeats the concept title already shown in the reader chrome. */
export function stripLeadingTitle(body: string, title?: string): string {
  const trimmed = body.trim();
  const heading = title?.trim();
  if (!heading) {
    return trimmed;
  }
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return trimmed.replace(new RegExp(`^#\\s+${escaped}\\s*(?:\\n+|$)`, "i"), "").trim();
}

export function isExternalHref(href: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(href.trim());
}

/** Concept id for an OKF markdown href, or undefined for web / hash / other files. */
export function conceptIdFromHref(href: string | undefined): string | undefined {
  if (!href) {
    return undefined;
  }
  const path = href.trim().replace(/^\.\//, "").split(/[?#]/)[0] ?? "";
  const match = CONCEPT_HREF.exec(path);
  if (!match) {
    return undefined;
  }
  return match[1].replace(/\.md$/i, "");
}
