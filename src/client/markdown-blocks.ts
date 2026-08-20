import { conceptIdFromHref, isExternalHref } from "./markdown.ts";

export type MdBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string }
  | { type: "code"; text: string }
  | { type: "hr" }
  | { type: "table"; headers: string[]; rows: string[][] };

/** Split markdown into blocks. Covers the OKF note/survey subset (GFM tables, lists, fences). */
export function parseMarkdownBlocks(source: string): MdBlock[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (/^```/.test(line)) {
      const collected: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index] ?? "")) {
        collected.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({ type: "code", text: collected.join("\n") });
      continue;
    }
    if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length as 1 | 2 | 3 | 4;
      blocks.push({ type: "heading", level, text: heading[2].trim() });
      index += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const collected: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index] ?? "")) {
        collected.push((lines[index] ?? "").replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", text: collected.join("\n") });
      continue;
    }
    if (isTableStart(lines, index)) {
      const headers = splitRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        rows.push(splitRow(lines[index] ?? ""));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }
    const unordered = /^[-*+]\s+/.test(line);
    const ordered = /^\d+[.)]\s+/.test(line);
    if (unordered || ordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const match = unordered ? /^[-*+]\s+(.*)$/.exec(current) : /^\d+[.)]\s+(.*)$/.exec(current);
        if (!match) {
          break;
        }
        items.push(match[1]);
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    const collected: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (
        current.trim() === ""
        || /^(#{1,4})\s+/.test(current)
        || /^[-*+]\s+/.test(current)
        || /^\d+[.)]\s+/.test(current)
        || /^```/.test(current)
        || /^>\s?/.test(current)
        || /^---+\s*$/.test(current)
      ) {
        break;
      }
      collected.push(current);
      index += 1;
    }
    blocks.push({ type: "paragraph", text: collected.join("\n") });
  }
  return blocks;
}

export type MdInline =
  | { type: "text"; text: string }
  | { type: "strong"; text: string }
  | { type: "em"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; href: string; text: string; conceptId?: string; external: boolean };

export function parseInline(text: string): MdInline[] {
  const parts: MdInline[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    if (match.index > last) {
      parts.push({ type: "text", text: text.slice(last, match.index) });
    }
    const token = match[0];
    if (token.startsWith("`")) {
      parts.push({ type: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("**") || token.startsWith("__")) {
      parts.push({ type: "strong", text: token.slice(2, -2) });
    } else if (token.startsWith("![")) {
      const alt = /^!\[([^\]]*)\]/.exec(token);
      parts.push({ type: "text", text: alt?.[1] || "" });
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      const href = link?.[2]?.trim() ?? "";
      const label = link?.[1] ?? "";
      parts.push({
        type: "link",
        href,
        text: label,
        conceptId: conceptIdFromHref(href),
        external: isExternalHref(href),
      });
    } else {
      parts.push({ type: "em", text: token.slice(1, -1) });
    }
    last = match.index + token.length;
    match = pattern.exec(text);
  }
  if (last < text.length) {
    parts.push({ type: "text", text: text.slice(last) });
  }
  return parts;
}

function isTableStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  const divider = lines[index + 1] ?? "";
  return line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(divider);
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}
