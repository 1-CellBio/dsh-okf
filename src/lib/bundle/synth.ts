import type { FileStore } from "@/lib/fs/types";
import { serializeDocument } from "@/lib/okf/serialize";
import type { Frontmatter } from "@/types/okf";

export type SynthBundleOptions = {
  papers?: number;
  topics?: number;
  claimsPerPaper?: number;
  extracts?: number;
  fromYear?: number;
  toYear?: number;
};

export type SynthBundleStats = {
  papers: number;
  topics: number;
  claims: number;
  extracts: number;
  notes: number;
  questions: number;
  surveys: number;
};

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function yearFor(index: number, count: number, fromYear: number, toYear: number): number {
  if (count <= 1 || fromYear >= toYear) {
    return fromYear;
  }
  const span = toYear - fromYear;
  return fromYear + (index % (span + 1));
}

/** Write a tiny OKF bundle for scale tests. Not real literature. */
export async function writeSynthBundle(
  store: FileStore,
  options: SynthBundleOptions = {},
): Promise<SynthBundleStats> {
  const papers = Math.max(1, options.papers ?? 1000);
  const topics = Math.max(1, options.topics ?? 20);
  const claimsPerPaper = Math.max(0, options.claimsPerPaper ?? 1);
  const extracts = Math.min(papers, options.extracts ?? papers);
  const fromYear = options.fromYear ?? 2000;
  const toYear = options.toYear ?? 2024;

  for (let i = 0; i < topics; i += 1) {
    const id = `topics/topic-${pad(i, 2)}`;
    const frontmatter: Frontmatter = { type: "Topic", title: `Topic ${pad(i, 2)}` };
    const links = Array.from({ length: Math.min(8, Math.ceil(papers / topics)) }, (_, k) => {
      const paperIndex = i + k * topics;
      if (paperIndex >= papers) {
        return "";
      }
      const year = yearFor(paperIndex, papers, fromYear, toYear);
      return `- [Paper ${pad(paperIndex, 4)}](/papers/${year}-paper-${pad(paperIndex, 4)}.md)`;
    }).filter(Boolean);
    await store.write(`${id}.md`, serializeDocument(frontmatter, `${links.join("\n")}\n`));
  }

  let claims = 0;
  for (let i = 0; i < papers; i += 1) {
    const year = yearFor(i, papers, fromYear, toYear);
    const slug = `${year}-paper-${pad(i, 4)}`;
    const paperId = `papers/${slug}`;
    const topicIndex = i % topics;
    const topicPath = `topics/topic-${pad(topicIndex, 2)}.md`;
    const claimLinks: string[] = [];
    for (let c = 0; c < claimsPerPaper; c += 1) {
      const claimId = `claims/${slug}--c${c + 1}`;
      claimLinks.push(`- [Claim ${c + 1}](/${claimId}.md)`);
      await store.write(
        `${claimId}.md`,
        serializeDocument(
          {
            type: "Claim",
            title: `Claim ${c + 1} of paper ${pad(i, 4)}`,
            paper: paperId,
            confidence: "extracted",
            stance: "reports",
          },
          `> Paper ${pad(i, 4)} reports result ${c + 1}.\n\n[${slug}](/${paperId}.md)\n`,
        ),
      );
      claims += 1;
    }
    await store.write(
      `${paperId}.md`,
      serializeDocument(
        {
          type: "Paper",
          title: `Synthetic paper ${pad(i, 4)}`,
          published: `${year}-01-15`,
        },
        `Digest for synthetic paper ${pad(i, 4)} on topic ${pad(topicIndex, 2)}.\n\n[Topic](/${topicPath})\n${claimLinks.join("\n")}\n`,
      ),
    );
    if (i < extracts) {
      await store.write(
        `extracts/paper-${pad(i, 4)}.md`,
        serializeDocument(
          {
            type: "TextExtract",
            title: `extract ${pad(i, 4)}`,
            paper: paperId,
          },
          `Synthetic extract for paper ${pad(i, 4)}. Topic ${pad(topicIndex, 2)} is discussed. Result ${i} holds.\n`,
        ),
      );
    }
  }

  await store.write(
    "notes/synth-note.md",
    serializeDocument(
      { type: "Note", title: "Synth note", status: "draft" },
      `Scale-test note.\n\n## Sources\n\n- [Paper](/papers/${yearFor(0, papers, fromYear, toYear)}-paper-0000.md)\n`,
    ),
  );
  await store.write(
    "questions/synth-gap.md",
    serializeDocument(
      { type: "Question", title: "Synth gap" },
      "Is topic-00 covered after 2020?\n\n[Topic](/topics/topic-00.md)\n",
    ),
  );
  await store.write(
    "surveys/synth-survey.md",
    serializeDocument(
      { type: "Survey", title: "Synth survey", status: "draft" },
      "Local-bundle outline only.\n",
    ),
  );

  return {
    papers,
    topics,
    claims,
    extracts,
    notes: 1,
    questions: 1,
    surveys: 1,
  };
}
