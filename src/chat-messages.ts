import type { ChatContentPart, ChatMessage } from "@/lib/providers/types";

export type SplitChatMessages = {
  system: string | undefined;
  rest: ChatMessage[];
};

export function splitChatMessages(messages: ChatMessage[]): SplitChatMessages {
  const systemParts: string[] = [];
  const rest: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      const text = contentToText(message.content);
      if (text.trim()) {
        systemParts.push(text);
      }
      continue;
    }
    rest.push(message);
  }
  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    rest,
  };
}

export function contentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((part): part is Extract<ChatContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export type ParsedDataUrl = {
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  bytes: Uint8Array;
};

const DATA_URL_RE = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i;

export function parseImageDataUrl(url: string): ParsedDataUrl {
  const match = DATA_URL_RE.exec(url.trim());
  if (!match?.[1] || !match[2]) {
    throw new Error(
      "image_url must be a data:image/(png|jpeg|webp|gif);base64 URL; http(s) image URLs are not fetched",
    );
  }
  const declared = match[1].toLowerCase();
  const mediaType = declared === "image/jpg" ? "image/jpeg" : (declared as ParsedDataUrl["mediaType"]);
  const bytes = Uint8Array.from(Buffer.from(match[2], "base64"));
  if (bytes.byteLength === 0) {
    throw new Error("image_url data URL decoded to empty bytes");
  }
  return { mediaType, bytes };
}

export function chatHasImages(messages: ChatMessage[]): boolean {
  return messages.some((message) => {
    if (typeof message.content === "string") {
      return false;
    }
    return message.content.some((part) => part.type === "image_url");
  });
}
