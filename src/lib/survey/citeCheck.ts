import { extractLinks, toConceptId } from "@/lib/okf/links";

const CITE_TYPES = new Set(["papers", "claims"]);

export type CiteCheckResult = {
  ok: boolean;
  cited: string[];
  illegal: string[];
};

export function citeLinksInBody(body: string, path = "surveys/draft.md"): string[] {
  return extractLinks(body, path).filter((id) => {
    const type = id.split("/")[0];
    return type !== undefined && CITE_TYPES.has(type);
  });
}

export function citeCheck(body: string, allowedIds: Iterable<string>): CiteCheckResult {
  const allowed = new Set([...allowedIds].map((id) => toConceptId(id)));
  const cited = citeLinksInBody(body);
  const illegal = cited.filter((id) => !allowed.has(id));
  return { ok: illegal.length === 0, cited, illegal };
}

export function stripIllegalCiteLinks(body: string, illegalIds: Iterable<string>): string {
  const illegal = new Set([...illegalIds].map((id) => toConceptId(id)));
  return body.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (full, label: string, href: string) => {
    const id = toConceptId(href.replace(/^\/+/, "").split("#")[0] ?? href);
    const type = id.split("/")[0];
    if (type && CITE_TYPES.has(type) && illegal.has(id)) {
      return label;
    }
    return full;
  });
}
