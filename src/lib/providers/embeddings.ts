import type { EmbeddingClient, EmbeddingEndpoint } from "./types";
import { EMBED_TIMEOUT_MS, fetchWithTimeout } from "./http";

export const EMBED_BATCH = 32;

export class OpenAICompatibleEmbeddings implements EmbeddingClient {
  constructor(private readonly config: EmbeddingEndpoint) {}

  get model(): string {
    return this.config.model.trim();
  }

  async embed(texts: string[]): Promise<number[][]> {
    const input = texts.map((text) => text.trim()).filter(Boolean);
    if (input.length === 0) {
      return [];
    }
    const out: number[][] = [];
    for (let i = 0; i < input.length; i += EMBED_BATCH) {
      out.push(...(await this.embedBatch(input.slice(i, i + EMBED_BATCH))));
    }
    return out;
  }

  private async embedBatch(input: string[]): Promise<number[][]> {
    const base = this.config.baseUrl.replace(/\/$/, "");
    const model = this.config.model.trim();
    if (!model) {
      throw new Error("Embedding model is empty");
    }
    const response = await fetchWithTimeout(
      `${base}/embeddings`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input }),
      },
      EMBED_TIMEOUT_MS,
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Embedding request failed (${response.status}): ${detail.slice(0, 300)}`);
    }
    const json = (await response.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
    };
    const rows = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (rows.length !== input.length) {
      throw new Error(`Embedding response size ${rows.length} != ${input.length}`);
    }
    return rows.map((row) => {
      if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
        throw new Error("Embedding response missing vector");
      }
      return row.embedding;
    });
  }
}
