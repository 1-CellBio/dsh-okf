import { buildAgentContext } from "@/lib/agent/buildContext";
import type { ChatMode } from "@/lib/agent/types";
import type { BundleIndex } from "@/lib/index/rebuild";
import type { ChatClient, EmbeddingClient } from "@/lib/providers/types";
import { queryVectorHits } from "@/lib/retrieve/query";

export async function askBundle(
  index: BundleIndex,
  client: ChatClient,
  question: string,
  mode: ChatMode = "ask",
  options?: { embed?: EmbeddingClient },
): Promise<string> {
  const vectorHits = await queryVectorHits(index, options?.embed, question);
  return client.complete([
    { role: "system", content: buildAgentContext(index, question, { mode, vectorHits }) },
    { role: "user", content: question },
  ]);
}
