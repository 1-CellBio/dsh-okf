import type { EmbeddingEndpoint, ProviderConfig } from "./types";

export function emptyEmbeddingEndpoint(): EmbeddingEndpoint {
  return { baseUrl: "", apiKey: "", model: "" };
}

/**
 * Embedding is opt-in. An empty model means FTS only — never fall back to the chat model.
 * Blank base URL / API key inherit the chat provider, because some hosts share one key.
 */
export function resolveEmbeddingEndpoint(config: ProviderConfig): EmbeddingEndpoint | undefined {
  const model = config.embedding?.model.trim() || config.embedModel?.trim() || "";
  if (!model) {
    return undefined;
  }
  const baseUrl = config.embedding?.baseUrl.trim() || config.baseUrl.trim();
  if (!baseUrl) {
    return undefined;
  }
  return {
    model,
    baseUrl,
    apiKey: config.embedding?.apiKey.trim() || config.apiKey,
  };
}
