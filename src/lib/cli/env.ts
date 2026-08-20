import { existsSync, readFileSync } from "node:fs";

export function loadDotEnv(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }
  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function resolveProviderFromEnv(): {
  baseUrl: string;
  apiKey: string;
  model: string;
  embedding: { baseUrl: string; apiKey: string; model: string };
} {
  const baseUrl =
    process.env.KG_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const apiKey = process.env.KG_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  const model = process.env.KG_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const embedding = {
    baseUrl: process.env.KG_EMBED_BASE_URL ?? process.env.OPENAI_EMBED_BASE_URL ?? "",
    apiKey: process.env.KG_EMBED_API_KEY ?? process.env.OPENAI_EMBED_API_KEY ?? "",
    model: process.env.KG_EMBED_MODEL ?? process.env.OPENAI_EMBED_MODEL ?? "",
  };
  if (!apiKey && !/localhost|127\.0\.0\.1/.test(baseUrl)) {
    throw new Error("Missing KG_API_KEY or OPENAI_API_KEY. Put it in .env.");
  }
  return { baseUrl, apiKey, model, embedding };
}
