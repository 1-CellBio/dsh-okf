export const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export function ensureLink(body: string, title: string, href: string): string {
  if (body.includes(href)) {
    return body;
  }
  return `${body.trimEnd()}\n\n- [${title}](${href})\n`;
}

export function normalizeHref(href: string): string {
  const withoutHash = href.split("#")[0] ?? href;
  return withoutHash.startsWith("/") ? withoutHash : `/${withoutHash.replace(/^\/+/, "")}`;
}

function isPaperHref(href: string): boolean {
  const path = href.replace(/^\/+/, "");
  return path.startsWith("papers/") && path.endsWith(".md");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Point markdown links at the aligned concept path when the model invented a synonym slug. */
export function rewriteBundleHref(body: string, fromPath: string, toPath: string): string {
  const from = fromPath.replace(/^\/+/, "");
  const to = `/${toPath.replace(/^\/+/, "")}`;
  if (from === to.slice(1)) {
    return body;
  }
  const pattern = new RegExp(`\\((?:\\/)?${escapeRegExp(from)}\\)`, "g");
  return body.replace(pattern, `(${to})`);
}

/** Keep previously compiled Paper backlinks when a shared Topic/Method/Entity is rewritten. */
export function mergePaperLinks(existingBody: string, incomingBody: string): string {
  let body = incomingBody;
  for (const match of existingBody.matchAll(LINK_RE)) {
    const title = match[1]?.trim() || "Paper";
    const href = normalizeHref(match[2] ?? "");
    if (!isPaperHref(href)) {
      continue;
    }
    body = ensureLink(body, title, href);
  }
  return body;
}
