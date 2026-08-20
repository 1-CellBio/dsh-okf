import type { ChatClient, ChatMessage, ProviderConfig } from "./types";
import { fetchWithTimeout, LLM_TIMEOUT_MS } from "./http";

export class OpenAICompatibleClient implements ChatClient {
  constructor(private readonly config: ProviderConfig) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    const base = this.config.baseUrl.replace(/\/$/, "");
    const response = await fetchWithTimeout(
      `${base}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          messages,
        }),
      },
      LLM_TIMEOUT_MS,
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`LLM request failed (${response.status}): ${detail.slice(0, 300)}`);
    }
    const json = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error("LLM returned empty content");
    }
    return content;
  }
}
