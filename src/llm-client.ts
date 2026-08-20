import type { Context } from "@deepseek-ai/cordis";
import { createMessage, createUserMessage, type ContentBlock, type GenerateOptions, type ImageBlock } from "@deepseek-ai/dsh-llm";
import type { ChatClient, ChatContentPart, ChatMessage } from "@/lib/providers/types";
import { contentToText, parseImageDataUrl, splitChatMessages } from "./chat-messages";

const PLUGIN = "dsh-okf";

export function harnessChatClient(ctx: Context, signal?: AbortSignal): ChatClient {
  return {
    async complete(messages: ChatMessage[]): Promise<string> {
      const llm = ctx.get("llm");
      if (llm === undefined) {
        throw new Error("dsh-okf compile needs ctx.llm — load @deepseek-ai/dsh-llm");
      }
      const defaults = ctx.get("agentDefaultModel");
      if (defaults === undefined) {
        throw new Error(
          "dsh-okf compile needs ctx.agentDefaultModel — load @deepseek-ai/dsh-agent-default-model",
        );
      }
      const selection = defaults.currentSelection();
      const { system, rest } = splitChatMessages(messages);
      const harnessMessages = await toHarnessMessages(ctx, rest);
      const options: GenerateOptions = {
        provider: selection.provider,
        model: selection.model,
        messages: harnessMessages,
        ...(system !== undefined ? { system } : {}),
        ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
        ...(signal !== undefined ? { signal } : {}),
      };
      return collectText(llm.stream(options));
    },
  };
}

export function requireHarnessModel(ctx: Context): { provider: string; model: string } {
  const defaults = ctx.get("agentDefaultModel");
  if (defaults === undefined) {
    throw new Error(
      "dsh-okf compile needs ctx.agentDefaultModel — load @deepseek-ai/dsh-agent-default-model",
    );
  }
  const selection = defaults.currentSelection();
  return { provider: selection.provider, model: selection.model };
}

async function toHarnessMessages(ctx: Context, messages: ChatMessage[]) {
  const out = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push(
        createUserMessage({
          content: await toContentBlocks(ctx, message.content),
          source: { kind: "plugin", plugin: PLUGIN },
        }),
      );
      continue;
    }
    if (message.role === "assistant") {
      out.push(
        createMessage({
          role: "assistant",
          content: [{ type: "text", text: contentToText(message.content) }],
          source: { kind: "plugin", plugin: PLUGIN },
        }),
      );
    }
  }
  return out;
}

async function toContentBlocks(ctx: Context, content: ChatMessage["content"]): Promise<ContentBlock[]> {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  const blocks: ContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    blocks.push(await toImageBlock(ctx, part));
  }
  if (blocks.length === 0) {
    return [{ type: "text", text: "" }];
  }
  return blocks;
}

async function toImageBlock(ctx: Context, part: Extract<ChatContentPart, { type: "image_url" }>): Promise<ImageBlock> {
  const attachments = ctx.get("attachments");
  if (attachments === undefined) {
    throw new Error(
      "vision complete() needs ctx.attachments (dsh-attachment-local). The harness base bundle provides it.",
    );
  }
  const parsed = parseImageDataUrl(part.image_url.url);
  const attachment = await attachments.saveImage({
    data: parsed.bytes,
    mediaType: parsed.mediaType,
  });
  return { type: "image", attachment };
}

async function collectText(stream: AsyncIterable<{ type: string; text?: string; reason?: { kind: string; failure?: { message: string } } }>): Promise<string> {
  let text = "";
  let error: string | undefined;
  for await (const chunk of stream) {
    if (chunk.type === "text-delta" && typeof chunk.text === "string") {
      text += chunk.text;
    }
    if (chunk.type === "finish" && chunk.reason) {
      if (chunk.reason.kind === "error" || chunk.reason.kind === "aborted") {
        error = chunk.reason.failure?.message ?? chunk.reason.kind;
      }
    }
  }
  if (error) {
    throw new Error(error);
  }
  return text;
}
