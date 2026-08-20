export const VISUAL_HEADING = "## Visual extracts";
export const EMBEDDED_TEXT_HEADING = "## Embedded text layer";

export function stripVisualSection(body: string): string {
  const marked = `\n${VISUAL_HEADING}`;
  const idx = body.indexOf(marked);
  if (idx >= 0) {
    return body.slice(0, idx).trimEnd();
  }
  if (body.startsWith(VISUAL_HEADING)) {
    return "";
  }
  return body.trimEnd();
}

export function mergeVisualBody(textLayer: string, visualMarkdown: string, scan: boolean): string {
  const visual = visualMarkdown.trim();
  const embedded = stripVisualSection(textLayer).trim();
  if (scan) {
    if (!visual) {
      return embedded;
    }
    if (!embedded) {
      return `${visual}\n`;
    }
    return `${visual}\n\n${EMBEDDED_TEXT_HEADING}\n\n${embedded}\n`;
  }
  if (!visual) {
    return embedded ? `${embedded}\n` : "";
  }
  if (!embedded) {
    return `${VISUAL_HEADING}\n\n${visual}\n`;
  }
  return `${embedded}\n\n${VISUAL_HEADING}\n\n${visual}\n`;
}

export function visionIsComplete(pages: number[], done: number[]): boolean {
  if (pages.length === 0) {
    return true;
  }
  const have = new Set(done);
  return pages.every((page) => have.has(page));
}

/** Visual markdown already stored on an extract, or empty if none. */
export function visualSectionOf(body: string, scan: boolean): string {
  if (scan) {
    const embed = `\n${EMBEDDED_TEXT_HEADING}`;
    const idx = body.indexOf(embed);
    if (idx >= 0) {
      return body.slice(0, idx).trim();
    }
    return /^### Page \d+/m.test(body) ? body.trim() : "";
  }
  const marked = `\n${VISUAL_HEADING}`;
  const idx = body.startsWith(VISUAL_HEADING) ? 0 : body.indexOf(marked);
  if (idx < 0) {
    return "";
  }
  const start = idx === 0 ? VISUAL_HEADING.length : idx + marked.length;
  return body.slice(start).replace(/^\n+/, "").trim();
}

export function joinVisualMarkdown(previous: string, next: string): string {
  const left = previous.trim();
  const right = next.trim();
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return `${left}\n\n${right}`;
}
