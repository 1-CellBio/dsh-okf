import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { rebuildIndex, type BundleIndex } from "@/lib/index/rebuild";
import { generatedBy } from "@/lib/okf/generated";
import { conceptPath } from "@/lib/okf/links";
import { parseDocument } from "@/lib/okf/parse";
import { serializeDocument } from "@/lib/okf/serialize";
import { conceptSlug } from "@/lib/okf/slug";
import { isHumanVerified } from "@/lib/okf/validate";
import type { ChatClient } from "@/lib/providers/types";
import type { Frontmatter } from "@/types/okf";
import { papersToBibtex } from "./bibtex";
import { citeCheck, stripIllegalCiteLinks } from "./citeCheck";
import { mergeGeneratedBlocks, wrapGenerated } from "./generated";
import { SURVEY_SYSTEM_PROMPT, surveyRepairPrompt, surveyUserPrompt } from "./prompt";
import { buildSurveyRetrieval, coverageAppendixMarkdown, type SurveyScope } from "./scope";

export type CompileSurveyInput = SurveyScope & {
  title?: string;
  outPath?: string;
};

export type CompileSurveyResult = {
  path: string;
  cited: string[];
  illegal: string[];
  preservedHuman: boolean;
};

function surveyTitle(scope: SurveyScope, explicit?: string): string {
  if (explicit?.trim()) {
    return explicit.trim();
  }
  const topic = (scope.topics?.[0] ?? scope.topic ?? "literature").replace(/^topics\//, "");
  const from = scope.from ?? "";
  const to = scope.to ?? "";
  const years = from && to ? `, ${from}–${to}` : from || to ? `, ${from || to}` : "";
  return `${topic}${years}`;
}

function surveyPath(title: string, outPath?: string): string {
  if (outPath?.trim()) {
    const raw = outPath.trim().replace(/^\/+/, "").replace(/\\/g, "/");
    const segments = raw.split("/");
    if (segments.includes("..") || segments.includes(".") || segments.some((segment) => !segment)) {
      // Guard against in-library traversal such as `surveys/../../papers/evil.md`
      // which would overwrite arbitrary files inside the OKF root.
      throw new Error(`Refusing survey out path with path traversal: ${outPath}`);
    }
    if (raw.startsWith("surveys/") && raw.endsWith(".md")) {
      return raw;
    }
    if (raw.endsWith(".md")) {
      return `surveys/${raw.split("/").pop()}`;
    }
    return `surveys/${conceptSlug(raw)}.md`;
  }
  return `surveys/${conceptSlug(title)}.md`;
}

function stripFrontmatterFence(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```$/i, "").trim();
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end >= 0) {
      text = text.slice(end + 4).trim();
    }
  }
  return text;
}

async function draftBody(client: ChatClient, retrieval: ReturnType<typeof buildSurveyRetrieval>, title: string): Promise<string> {
  const first = await client.complete([
    { role: "system", content: SURVEY_SYSTEM_PROMPT },
    { role: "user", content: surveyUserPrompt(retrieval, title) },
  ]);
  let body = stripFrontmatterFence(first);
  let check = citeCheck(body, retrieval.allowedIds);
  if (!check.ok) {
    const repaired = await client.complete([
      { role: "system", content: SURVEY_SYSTEM_PROMPT },
      { role: "user", content: surveyRepairPrompt(body, check.illegal) },
    ]);
    body = stripFrontmatterFence(repaired);
    check = citeCheck(body, retrieval.allowedIds);
    if (!check.ok) {
      body = stripIllegalCiteLinks(body, check.illegal);
    }
  }
  return body;
}

export async function compileSurvey(
  store: FileStore,
  client: ChatClient,
  input: CompileSurveyInput,
  options: { model: string; now?: string; index?: BundleIndex },
): Promise<CompileSurveyResult> {
  const index = options.index ?? (await rebuildIndex(store));
  const scope: SurveyScope = {
    topic: input.topic,
    topics: input.topics ?? (input.topic ? [input.topic] : undefined),
    methods: input.methods,
    from: input.from,
    to: input.to,
    question: input.question,
  };
  const retrieval = buildSurveyRetrieval(index, scope);
  const title = surveyTitle(scope, input.title);
  const path = surveyPath(title, input.outPath);
  const generated = {
    by: generatedBy(options.model),
    at: options.now ?? new Date().toISOString(),
  };

  const draft = await draftBody(client, retrieval, title);
  const appendix = wrapGenerated("coverage", coverageAppendixMarkdown(retrieval));
  const machineBody = `${draft.trim()}\n\n${appendix}\n`;
  const check = citeCheck(machineBody, retrieval.allowedIds);
  const cited = [...new Set(check.cited.filter((id) => id.startsWith("papers/")))];
  const body = machineBody;

  const frontmatter: Frontmatter = {
    type: "Survey",
    title,
    status: "draft",
    scope: {
      ...(scope.topics && scope.topics.length > 0 ? { topics: scope.topics } : {}),
      ...(scope.from ? { from: scope.from } : {}),
      ...(scope.to ? { to: scope.to } : {}),
    },
    cited,
    coverage: {
      papers_in_scope: retrieval.papers.length,
      papers_cited: cited.length,
      missing_years: [...new Set(retrieval.matrix.topics.flatMap((row) => row.missingYears))].sort(),
    },
    generated,
  };

  if (await store.exists(path)) {
    const existing = parseDocument(utf8Decode(await store.read(path)));
    if (isHumanVerified(existing.frontmatter)) {
      const body = mergeGeneratedBlocks(existing.body, machineBody);
      await store.write(
        path,
        serializeDocument(
          {
            ...existing.frontmatter,
            coverage: frontmatter.coverage,
            generated,
          },
          body,
        ),
      );
      return {
        path,
        cited,
        illegal: citeCheck(body, retrieval.allowedIds).illegal,
        preservedHuman: true,
      };
    }
  }

  await store.write(path, serializeDocument(frontmatter, body));
  return {
    path,
    cited,
    illegal: citeCheck(body, retrieval.allowedIds).illegal,
    preservedHuman: false,
  };
}

export async function bibtexForSurvey(store: FileStore, surveyPath: string): Promise<string> {
  const doc = parseDocument(utf8Decode(await store.read(conceptPath(surveyPath))));
  const cited = Array.isArray(doc.frontmatter.cited)
    ? doc.frontmatter.cited.filter((item): item is string => typeof item === "string")
    : [];
  const papers: Array<{ frontmatter: Frontmatter; id: string }> = [];
  for (const id of cited) {
    const paperPath = conceptPath(id);
    if (!(await store.exists(paperPath))) {
      continue;
    }
    const paper = parseDocument(utf8Decode(await store.read(paperPath)));
    papers.push({ frontmatter: paper.frontmatter, id: id.replace(/\.md$/i, "") });
  }
  return papersToBibtex(papers);
}
