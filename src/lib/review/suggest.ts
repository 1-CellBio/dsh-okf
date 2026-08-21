import { catalogSymbolPair, looksLikeVersionPair } from "@/lib/compile/hubMatch";
import type { ChatClient } from "@/lib/providers/types";

export type ReviewKeep = "left" | "right" | "both";

export type ReviewSuggest = {
  keep: ReviewKeep;
  reason: string;
  source: "ai" | "heuristic";
};

const BODY_CAP = 700;

const SYSTEM = `You decide how to resolve two OKF concept pages flagged as near-duplicates.
Return JSON only, no markdown: {"keep":"left"|"right"|"both","reason":"<one short Chinese sentence>"}
Rules:
- keep=left or keep=right: they are the same concept; that side's title should be canonical.
- keep=both: they are distinct (different genes, datasets, methods, papers, or versioned tools).
- Prefer the more specific scholarly name when they are the same thing.
- When unsure, keep both.
- Cellpose vs Cellpose3, COL5A1 vs COL4A1, or two simulations from different papers → both.`;

export function heuristicSuggest(input: {
  reason: string;
  leftTitle: string;
  rightTitle: string;
}): ReviewSuggest {
  const left = input.leftTitle.trim();
  const right = input.rightTitle.trim();
  if (catalogSymbolPair(left, right) || looksLikeVersionPair(left, right)) {
    return { keep: "both", reason: "标题像不同的符号或版本，建议先分开保留。", source: "heuristic" };
  }
  if (input.reason.includes("token:contain") && left.length !== right.length) {
    return {
      keep: right.length >= left.length ? "right" : "left",
      reason: "同一概念时保留更完整、更具体的标题。",
      source: "heuristic",
    };
  }
  return { keep: "right", reason: "默认保留当前规范名候选（右侧）。", source: "heuristic" };
}

export async function suggestNearDuplicate(
  client: ChatClient,
  input: {
    reason: string;
    leftTitle: string;
    leftPath: string;
    leftBody: string;
    rightTitle: string;
    rightPath: string;
    rightBody: string;
  },
): Promise<ReviewSuggest> {
  const fallback = heuristicSuggest(input);
  try {
    const raw = await client.complete([
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: [
          `Detector: ${input.reason || "near-duplicate"}`,
          "",
          "LEFT",
          `title: ${input.leftTitle}`,
          `path: ${input.leftPath}`,
          clip(input.leftBody),
          "",
          "RIGHT",
          `title: ${input.rightTitle}`,
          `path: ${input.rightPath}`,
          clip(input.rightBody),
        ].join("\n"),
      },
    ]);
    const parsed = parseSuggest(raw);
    if (parsed) {
      return { ...parsed, source: "ai" };
    }
  } catch {
    // Fall through to the deterministic hint.
  }
  return fallback;
}

function clip(body: string): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (text.length <= BODY_CAP) {
    return text;
  }
  return `${text.slice(0, BODY_CAP)}…`;
}

function parseSuggest(raw: string): { keep: ReviewKeep; reason: string } | undefined {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(match[0]) as { keep?: unknown; reason?: unknown };
    if (parsed.keep !== "left" && parsed.keep !== "right" && parsed.keep !== "both") {
      return undefined;
    }
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
    return { keep: parsed.keep, reason: reason || "模型建议这一项。" };
  } catch {
    return undefined;
  }
}
