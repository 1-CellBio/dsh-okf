import { emptyEmbeddingEndpoint } from "./embeddingConfig";
import type { EmbeddingEndpoint, ProviderConfig } from "./types";

export const PROVIDER_STORAGE_KEY = "kg.provider";

export type ProviderPresetId = "openai" | "ollama" | "lmstudio";

export const PROVIDER_PRESETS: Record<
  ProviderPresetId,
  { id: ProviderPresetId; label: string; baseUrl: string; model: string }
> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
  ollama: {
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.2",
  },
  lmstudio: {
    id: "lmstudio",
    label: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    model: "",
  },
};

function readEmbedding(parsed: Partial<ProviderConfig> & { embedModel?: string }): EmbeddingEndpoint {
  const nested = parsed.embedding;
  return {
    baseUrl: nested?.baseUrl ?? "",
    apiKey: nested?.apiKey ?? "",
    model: nested?.model?.trim() || parsed.embedModel?.trim() || "",
  };
}

export function defaultProviderConfig(): ProviderConfig {
  const preset = PROVIDER_PRESETS.openai;
  return {
    baseUrl: preset.baseUrl,
    apiKey: "",
    model: preset.model,
    embedding: emptyEmbeddingEndpoint(),
  };
}

export function normalizeProviderConfig(parsed: Partial<ProviderConfig> & { embedModel?: string }): ProviderConfig {
  const fallback = defaultProviderConfig();
  return {
    baseUrl: parsed.baseUrl ?? fallback.baseUrl,
    apiKey: parsed.apiKey ?? "",
    model: parsed.model ?? fallback.model,
    embedding: readEmbedding(parsed),
  };
}

export function loadProviderConfig(): ProviderConfig {
  if (typeof localStorage === "undefined") {
    return defaultProviderConfig();
  }
  const raw = localStorage.getItem(PROVIDER_STORAGE_KEY);
  if (!raw) {
    return defaultProviderConfig();
  }
  try {
    return normalizeProviderConfig(JSON.parse(raw) as Partial<ProviderConfig>);
  } catch {
    return defaultProviderConfig();
  }
}

export function saveProviderConfig(config: ProviderConfig): void {
  localStorage.setItem(PROVIDER_STORAGE_KEY, JSON.stringify(config));
}
