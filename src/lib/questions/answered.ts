import type { FileStore } from "@/lib/fs/types";
import type { BundleIndex } from "@/lib/index/rebuild";
import { utf8Decode } from "@/lib/fs/types";
import { asString } from "@/lib/okf/identity";
import { extractLinks, toConceptId } from "@/lib/okf/links";
import { parseDocument } from "@/lib/okf/parse";
import { serializeDocument } from "@/lib/okf/serialize";

/** Reviewed claims that must back a Question before it is marked answered. Spec left N open; 3 is the default. */
export const ANSWERED_CLAIM_THRESHOLD = 3;

export function questionIsAnswered(
  question: { body: string; path: string; topic?: string },
  index: BundleIndex,
  threshold = ANSWERED_CLAIM_THRESHOLD,
): boolean {
  const linked = extractLinks(question.body, question.path);
  const topicId = question.topic ? toConceptId(question.topic) : linked.find((id) => id.startsWith("topics/"));
  const paperIds = new Set(linked.filter((id) => id.startsWith("papers/")));
  if (topicId) {
    for (const record of index.concepts.values()) {
      if (record.type !== "Paper") {
        continue;
      }
      if (record.outgoing.includes(topicId)) {
        paperIds.add(record.id);
      }
    }
    const topic = index.concepts.get(topicId);
    for (const id of topic?.outgoing ?? []) {
      if (index.concepts.get(id)?.type === "Paper") {
        paperIds.add(id);
      }
    }
  }
  let reviewed = 0;
  for (const record of index.concepts.values()) {
    if (record.type !== "Claim") {
      continue;
    }
    if (record.confidence !== "reviewed" && !record.verifiedHuman) {
      continue;
    }
    if (record.paper && paperIds.has(record.paper)) {
      reviewed += 1;
    }
  }
  return reviewed >= threshold;
}

export async function markAnsweredQuestions(
  store: FileStore,
  index: BundleIndex,
  threshold = ANSWERED_CLAIM_THRESHOLD,
): Promise<{ answered: string[]; unchanged: string[] }> {
  const answered: string[] = [];
  const unchanged: string[] = [];
  for (const path of (await store.list("questions/")).filter((item) => item.endsWith(".md"))) {
    const doc = parseDocument(utf8Decode(await store.read(path)));
    if (asString(doc.frontmatter.type) !== "Question") {
      continue;
    }
    if (asString(doc.frontmatter.status) === "answered") {
      unchanged.push(path);
      continue;
    }
    const ok = questionIsAnswered(
      {
        body: doc.body,
        path,
        topic: asString(doc.frontmatter.topic),
      },
      index,
      threshold,
    );
    if (!ok) {
      continue;
    }
    await store.write(
      path,
      serializeDocument({ ...doc.frontmatter, status: "answered" }, doc.body),
    );
    answered.push(path);
  }
  return { answered, unchanged };
}
