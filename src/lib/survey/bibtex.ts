import { asString, asTags, displayDoi } from "@/lib/okf/identity";
import { publishedYear } from "@/lib/okf/slug";
import type { Frontmatter } from "@/types/okf";
import type { ConceptRecord } from "@/types/okf";

function bibKey(title: string, year?: string): string {
  const slug = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 24) || "paper";
  return year ? `${slug}${year}` : slug;
}

export type BibPaper = {
  id?: string;
  title?: string;
  published?: string;
  doi?: string;
  authors?: unknown;
  venue?: string;
};

/** Stable cite key from Paper title + year. Does not invent DOIs. */
export function citationKey(paper: Pick<BibPaper, "id" | "title" | "published">): string {
  const title = paper.title?.trim() || paper.id || "Untitled";
  const year = paper.published ? publishedYear(paper.published) : undefined;
  return bibKey(title, year);
}

/** Disambiguate colliding keys with a paper-id slug, then numeric suffix. */
export function uniqueCitationKeys(papers: Array<Pick<BibPaper, "id" | "title" | "published">>): Map<string, string> {
  const used = new Set<string>();
  const map = new Map<string, string>();
  papers.forEach((paper, index) => {
    const id = paper.id ?? `paper-${index}`;
    let key = citationKey(paper);
    if (used.has(key) && paper.id) {
      const slug = paper.id.replace(/^papers\//, "").replace(/[^a-z0-9]+/gi, "").slice(0, 12);
      if (slug) {
        key = `${citationKey(paper)}${slug}`;
      }
    }
    let candidate = key;
    let n = 2;
    while (used.has(candidate)) {
      candidate = `${key}${n}`;
      n += 1;
    }
    used.add(candidate);
    map.set(id, candidate);
  });
  return map;
}

function escapeBib(value: string): string {
  return value.replace(/[{}\\]/g, "\\$&");
}

function authorsField(authors: unknown): string | undefined {
  const list = asTags(authors);
  if (list.length === 0) {
    const single = asString(authors);
    return single;
  }
  return list.join(" and ");
}

export function paperToBibtex(paper: BibPaper, key?: string): string {
  const title = paper.title?.trim() || paper.id || "Untitled";
  const year = paper.published ? publishedYear(paper.published) : undefined;
  const doi = displayDoi(paper.doi);
  const authors = authorsField(paper.authors);
  const venue = paper.venue?.trim();
  const fields = [
    `  title = {${escapeBib(title)}}`,
    authors ? `  author = {${escapeBib(authors)}}` : undefined,
    year ? `  year = {${year}}` : undefined,
    venue ? `  journal = {${escapeBib(venue)}}` : undefined,
    doi ? `  doi = {${escapeBib(doi)}}` : undefined,
  ].filter((line): line is string => Boolean(line));
  return `@article{${key ?? citationKey(paper)},\n${fields.join(",\n")}\n}`;
}

function asBibPaper(paper: ConceptRecord | { frontmatter: Frontmatter; id?: string } | BibPaper): BibPaper {
  if ("frontmatter" in paper) {
    return {
      id: paper.id,
      title: asString(paper.frontmatter.title),
      published: asString(paper.frontmatter.published),
      doi: asString(paper.frontmatter.doi),
      authors: paper.frontmatter.authors,
      venue: asString(paper.frontmatter.venue),
    };
  }
  return paper;
}

export function papersToBibtex(papers: Array<ConceptRecord | { frontmatter: Frontmatter; id?: string } | BibPaper>): string {
  const list = papers.map(asBibPaper);
  const keys = uniqueCitationKeys(list);
  return list
    .map((paper, index) => paperToBibtex(paper, keys.get(paper.id ?? `paper-${index}`)))
    .join("\n\n");
}
