export function markdownLinkRe(): RegExp {
  return /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
}

export function toConceptId(path: string): string {
  const normalized = path.replace(/^\/+/, "").replace(/\\/g, "/");
  return normalized.replace(/\.md$/i, "");
}

export function conceptPath(id: string): string {
  return id.endsWith(".md") ? id.replace(/^\/+/, "") : `${id.replace(/^\/+/, "")}.md`;
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function resolveRelative(fromDir: string, rel: string): string {
  const parts = [...fromDir.split("/").filter(Boolean), ...rel.split("/")];
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") {
      continue;
    }
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

/** Bundle concept id for a markdown href, or undefined for web / hash / non-md. */
export function resolveMarkdownHref(href: string, currentPath: string): string | undefined {
  if (!href || href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:")) {
    return undefined;
  }
  if (href.startsWith("#")) {
    return undefined;
  }
  const withoutHash = href.split("#")[0] ?? href;
  const currentDir = dirname(currentPath.replace(/^\/+/, ""));
  const resolved = withoutHash.startsWith("/")
    ? withoutHash.replace(/^\/+/, "")
    : resolveRelative(currentDir, withoutHash);
  if (!resolved.endsWith(".md")) {
    return undefined;
  }
  return toConceptId(resolved);
}

/** Returns concept ids (no `.md`, no leading slash). */
export function extractLinks(body: string, currentPath: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(markdownLinkRe())) {
    const href = match[2];
    if (!href) {
      continue;
    }
    const id = resolveMarkdownHref(href, currentPath);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
