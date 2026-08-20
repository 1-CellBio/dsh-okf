export type ParsedReply = {
  thinking: string[];
  answer: string;
};

const EMOJI =
  /\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*/gu;
const SKIN_TONE = /[\u{1F3FB}-\u{1F3FF}]/gu;
const KEYCAP = /\u20E3/g;
const VARIATION = /[\uFE0F\uFE0E]/g;

export function stripEmoji(text: string): string {
  EMOJI.lastIndex = 0;
  SKIN_TONE.lastIndex = 0;
  return text
    .replace(EMOJI, "")
    .replace(SKIN_TONE, "")
    .replace(KEYCAP, "")
    .replace(VARIATION, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/ {2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseAssistantReply(raw: string): ParsedReply {
  const thinking: string[] = [];
  let rest = raw.replace(/<think(?:ing)?\b[^>]*>([\s\S]*?)<\/think(?:ing)?>/gi, (_, inner: string) => {
    const text = stripEmoji(inner).trim();
    if (text) {
      thinking.push(text);
    }
    return "\n";
  });
  rest = rest.replace(/<think(?:ing)?\b[^>]*>([\s\S]*)$/i, (_, inner: string) => {
    const text = stripEmoji(inner).trim();
    if (text) {
      thinking.push(text);
    }
    return "";
  });
  rest = rest.replace(/<\/think(?:ing)?>/gi, "");
  return {
    thinking,
    answer: stripEmoji(rest).trim(),
  };
}

export function visibleAssistantText(raw: string): string {
  return parseAssistantReply(raw).answer;
}
