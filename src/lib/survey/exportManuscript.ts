import { utf8Decode, utf8Encode } from "@/lib/fs/types";
import type { FileStore } from "@/lib/fs/types";
import { asString } from "@/lib/okf/identity";
import { conceptPath, markdownLinkRe, resolveMarkdownHref, toConceptId } from "@/lib/okf/links";
import { parseDocument } from "@/lib/okf/parse";
import type { Frontmatter } from "@/types/okf";
import { papersToBibtex, uniqueCitationKeys, type BibPaper } from "./bibtex";
import { citeLinksInBody } from "./citeCheck";
import { stripGeneratedBlocks } from "./generated";

export type CiteStyle = "pandoc" | "latex";

export type RewriteOkfLinksInput = {
  body: string;
  surveyPath: string;
  keys: Map<string, string>;
  claimPaper: Map<string, string>;
  style: CiteStyle;
};

export type RewriteOkfLinksResult = {
  body: string;
  unresolved: string[];
  citedPaperIds: string[];
};

export type SurveyManuscript = {
  title: string;
  surveyPath: string;
  stem: string;
  bibtex: string;
  pandocMarkdown: string;
  latex: string;
  citedKeys: string[];
  unresolved: string[];
};

const LABEL_ONLY_TYPES = new Set(["topics", "methods", "entities", "notes", "questions", "surveys"]);

function citeMarkup(label: string, key: string, style: CiteStyle): string {
  if (style === "latex") {
    return `${label}~\\cite{${key}}`;
  }
  return `${label} [@${key}]`;
}

function paperIdForLink(
  id: string,
  keys: Map<string, string>,
  claimPaper: Map<string, string>,
): { paperId?: string; unresolved?: string } {
  const type = id.split("/")[0];
  if (type === "papers") {
    if (keys.has(id)) {
      return { paperId: id };
    }
    return { unresolved: id };
  }
  if (type === "claims") {
    const paperId = claimPaper.get(id);
    if (!paperId) {
      return { unresolved: id };
    }
    if (!keys.has(paperId)) {
      return { unresolved: id };
    }
    return { paperId };
  }
  return {};
}

export function rewriteOkfLinks(input: RewriteOkfLinksInput): RewriteOkfLinksResult {
  const unresolved: string[] = [];
  const seenUnresolved = new Set<string>();
  const citedPaperIds: string[] = [];
  const seenCited = new Set<string>();
  const body = input.body.replace(markdownLinkRe(), (full, label: string, href: string) => {
    const id = resolveMarkdownHref(href, input.surveyPath);
    if (!id) {
      return full;
    }
    const type = id.split("/")[0];
    if (type && LABEL_ONLY_TYPES.has(type)) {
      return label;
    }
    if (type !== "papers" && type !== "claims") {
      return full;
    }
    const resolved = paperIdForLink(id, input.keys, input.claimPaper);
    if (resolved.unresolved) {
      if (!seenUnresolved.has(resolved.unresolved)) {
        seenUnresolved.add(resolved.unresolved);
        unresolved.push(resolved.unresolved);
      }
      return label;
    }
    if (!resolved.paperId) {
      return full;
    }
    const key = input.keys.get(resolved.paperId);
    if (!key) {
      return label;
    }
    if (!seenCited.has(resolved.paperId)) {
      seenCited.add(resolved.paperId);
      citedPaperIds.push(resolved.paperId);
    }
    return citeMarkup(label, key, input.style);
  });
  return { body, unresolved, citedPaperIds };
}

function escapeLatex(value: string): string {
  return value.replace(/[\\{}$&#^_%~]/g, (ch) => {
    const map: Record<string, string> = {
      "\\": "\\textbackslash{}",
      "{": "\\{",
      "}": "\\}",
      $: "\\$",
      "&": "\\&",
      "#": "\\#",
      "^": "\\textasciicircum{}",
      _: "\\_",
      "%": "\\%",
      "~": "\\textasciitilde{}",
    };
    return map[ch] ?? ch;
  });
}

export function setBibliographyStem(latex: string, stem: string): string {
  return latex.replace(/\\bibliography\{[^}]+\}/, `\\bibliography{${stem}}`);
}

function markdownBodyToLatex(md: string): string {
  return md
    .replace(/^#### (.+)$/gm, (_, title: string) => `\\subsubsection{${escapeLatex(title)}}`)
    .replace(/^### (.+)$/gm, (_, title: string) => `\\subsection{${escapeLatex(title)}}`)
    .replace(/^## (.+)$/gm, (_, title: string) => `\\section{${escapeLatex(title)}}`)
    .replace(/^# (.+)$/gm, (_, title: string) => `\\section*{${escapeLatex(title)}}`)
    .replace(/\*\*([^*]+)\*\*/g, (_, text: string) => `\\textbf{${text}}`);
}

export function latexDocument(title: string, body: string, bibStem: string): string {
  const converted = markdownBodyToLatex(body).trim();
  return [
    "\\documentclass{article}",
    "\\usepackage{hyperref}",
    `\\title{${escapeLatex(title)}}`,
    "\\begin{document}",
    "\\maketitle",
    "",
    converted,
    "",
    "\\bibliographystyle{plain}",
    `\\bibliography{${bibStem}}`,
    "\\end{document}",
    "",
  ].join("\n");
}

function pandocDocument(title: string, body: string): string {
  const escaped = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `---\ntitle: "${escaped}"\n---\n\n${body.trim()}\n`;
}

function surveyStem(surveyPath: string): string {
  const name = conceptPath(surveyPath).replace(/^surveys\//, "").replace(/\.md$/i, "");
  return name.replace(/[^A-Za-z0-9._-]+/g, "-") || "survey";
}

function citedFromFrontmatter(frontmatter: Frontmatter): string[] {
  return Array.isArray(frontmatter.cited)
    ? frontmatter.cited.filter((item): item is string => typeof item === "string").map((id) => toConceptId(id))
    : [];
}

async function loadPaper(store: FileStore, id: string): Promise<BibPaper | undefined> {
  const paperPath = conceptPath(id);
  if (!(await store.exists(paperPath))) {
    return undefined;
  }
  const doc = parseDocument(utf8Decode(await store.read(paperPath)));
  if (asString(doc.frontmatter.type) && asString(doc.frontmatter.type) !== "Paper") {
    return undefined;
  }
  return {
    id: toConceptId(id),
    title: asString(doc.frontmatter.title),
    published: asString(doc.frontmatter.published),
    doi: asString(doc.frontmatter.doi),
    authors: doc.frontmatter.authors,
    venue: asString(doc.frontmatter.venue),
  };
}

async function paperIdForClaim(store: FileStore, claimId: string): Promise<string | undefined> {
  const claimPath = conceptPath(claimId);
  if (!(await store.exists(claimPath))) {
    return undefined;
  }
  const doc = parseDocument(utf8Decode(await store.read(claimPath)));
  const paper = asString(doc.frontmatter.paper);
  return paper ? toConceptId(paper) : undefined;
}

export function manuscriptFiles(
  manuscript: SurveyManuscript,
  format: "md" | "tex",
): { path: string; data: Uint8Array }[] {
  if (format === "md") {
    return [
      { path: `${manuscript.stem}.md`, data: utf8Encode(manuscript.pandocMarkdown) },
      { path: `${manuscript.stem}.bib`, data: utf8Encode(ensureNewline(manuscript.bibtex)) },
    ];
  }
  return [
    { path: `${manuscript.stem}.tex`, data: utf8Encode(manuscript.latex) },
    { path: `${manuscript.stem}.bib`, data: utf8Encode(ensureNewline(manuscript.bibtex)) },
  ];
}

function ensureNewline(text: string): string {
  if (!text.trim()) {
    return "% no cited papers\n";
  }
  return text.endsWith("\n") ? text : `${text}\n`;
}

export async function exportSurveyManuscript(store: FileStore, surveyPath: string): Promise<SurveyManuscript> {
  const path = conceptPath(surveyPath);
  const doc = parseDocument(utf8Decode(await store.read(path)));
  const title = asString(doc.frontmatter.title) ?? surveyStem(path);
  const body = stripGeneratedBlocks(doc.body, ["coverage"]);
  const fmCited = citedFromFrontmatter(doc.frontmatter);
  const bodyCiteIds = citeLinksInBody(body, path);

  const claimPaper = new Map<string, string>();
  const paperIds = new Set<string>(fmCited.filter((id) => id.startsWith("papers/")));
  const unresolved: string[] = [];
  const seenUnresolved = new Set<string>();

  function noteUnresolved(id: string): void {
    if (!seenUnresolved.has(id)) {
      seenUnresolved.add(id);
      unresolved.push(id);
    }
  }

  for (const id of bodyCiteIds) {
    if (id.startsWith("papers/")) {
      paperIds.add(id);
      continue;
    }
    if (id.startsWith("claims/")) {
      const paperId = await paperIdForClaim(store, id);
      if (!paperId) {
        noteUnresolved(id);
        continue;
      }
      claimPaper.set(id, paperId);
      paperIds.add(paperId);
    }
  }

  const papers: BibPaper[] = [];
  for (const id of paperIds) {
    const paper = await loadPaper(store, id);
    if (!paper) {
      noteUnresolved(id);
      continue;
    }
    papers.push(paper);
  }

  const keys = uniqueCitationKeys(papers);
  const rewrite = rewriteOkfLinks({
    body,
    surveyPath: path,
    keys,
    claimPaper,
    style: "pandoc",
  });
  const latexRewrite = rewriteOkfLinks({
    body,
    surveyPath: path,
    keys,
    claimPaper,
    style: "latex",
  });
  for (const id of rewrite.unresolved) {
    noteUnresolved(id);
  }

  const bibtex = papersToBibtex(papers);
  const stem = surveyStem(path);
  const citedKeys = papers.map((paper) => keys.get(paper.id ?? "") ?? "").filter(Boolean);

  return {
    title,
    surveyPath: path,
    stem,
    bibtex: ensureNewline(bibtex),
    pandocMarkdown: pandocDocument(title, rewrite.body),
    latex: latexDocument(title, latexRewrite.body, stem),
    citedKeys,
    unresolved,
  };
}
