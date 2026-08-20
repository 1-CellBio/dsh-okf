export type ChatMode = "ask" | "compare" | "gap" | "survey-outline" | "cite";

export const CHAT_MODES: ChatMode[] = ["ask", "compare", "gap", "survey-outline", "cite"];

export function isChatMode(value: string): value is ChatMode {
  return (CHAT_MODES as string[]).includes(value);
}
