export type ChatRole = "system" | "user" | "assistant";

export type ChatTextPart = { type: "text"; text: string };
export type ChatImagePart = {
  type: "image_url";
  image_url: { url: string };
};
export type ChatContentPart = ChatTextPart | ChatImagePart;

export type ChatMessage = {
  role: ChatRole;
  content: string | ChatContentPart[];
};

export interface ChatClient {
  complete(messages: ChatMessage[]): Promise<string>;
}

export interface EmbeddingClient {
  /** Model used to embed texts. Optional so lightweight clients can omit it;
   * callers should skip vector search when it mismatches the stored index model. */
  model?: string;
  embed(texts: string[]): Promise<number[][]>;
}

export type EmbeddingEndpoint = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type ProviderConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  embedding: EmbeddingEndpoint;
  /** @deprecated migrated into embedding.model */
  embedModel?: string;
};

export function chatContentIsEmpty(content: ChatMessage["content"]): boolean {
  if (typeof content === "string") {
    return content.trim() === "";
  }
  return !content.some((part) =>
    part.type === "image_url" ? true : part.text.trim() !== "",
  );
}
