function generatedBlockRe(): RegExp {
  return /<!-- generated:([A-Za-z0-9_-]+) -->\s*([\s\S]*?)\s*<!-- \/generated:\1 -->/g;
}

export function wrapGenerated(name: string, content: string): string {
  return `<!-- generated:${name} -->\n${content.trim()}\n<!-- /generated:${name} -->`;
}

export function extractGeneratedBlocks(body: string): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const match of body.matchAll(generatedBlockRe())) {
    const name = match[1];
    if (name) {
      blocks.set(name, match[2]?.trim() ?? "");
    }
  }
  return blocks;
}

/** Drop generated blocks. Pass `names` to strip only those (e.g. `coverage`). */
export function stripGeneratedBlocks(body: string, names?: readonly string[]): string {
  const allow = names ? new Set(names) : undefined;
  const stripped = body.replace(generatedBlockRe(), (full, name: string) => {
    if (!allow || allow.has(name)) {
      return "";
    }
    return full;
  });
  const collapsed = stripped.replace(/\n{3,}/g, "\n\n").trim();
  return collapsed ? `${collapsed}\n` : "";
}

/** Replace named generated blocks in `existing` with those from `incoming`. Human text outside blocks is kept. */
export function mergeGeneratedBlocks(existing: string, incoming: string): string {
  const nextBlocks = extractGeneratedBlocks(incoming);
  if (nextBlocks.size === 0) {
    return existing;
  }
  let out = existing;
  const seen = new Set<string>();
  out = out.replace(generatedBlockRe(), (full, name: string) => {
    seen.add(name);
    const replacement = nextBlocks.get(name);
    if (replacement === undefined) {
      return full;
    }
    return wrapGenerated(name, replacement);
  });
  for (const [name, content] of nextBlocks) {
    if (!seen.has(name)) {
      out = `${out.trimEnd()}\n\n${wrapGenerated(name, content)}\n`;
    }
  }
  return out.endsWith("\n") ? out : `${out}\n`;
}
