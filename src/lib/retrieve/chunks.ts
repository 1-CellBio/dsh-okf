import { splitPassages } from "@/lib/retrieve/passages";
import type { ConceptRecord } from "@/types/okf";

export type EmbedChunk = {
  id: string;
  sourceId: string;
  kind: "extract" | "claim";
  ordinal: number;
  text: string;
};

/** Upper bound on embedding chunks kept per extract. Very long bodies would
 * otherwise produce hundreds of chunks, inflating both the per-query vector
 * scan and the `kg embed` API spend. The leading passages (abstract, intro)
 * carry the most retrieval value, so the earliest chunks are kept. */
export const EMBED_CHUNK_LIMIT = 16;

export function chunksForRecord(record: ConceptRecord): EmbedChunk[] {
  if (record.type === "TextExtract") {
    return splitPassages(record.body)
      .slice(0, EMBED_CHUNK_LIMIT)
      .map((text, ordinal) => ({
        id: `${record.id}#p${ordinal}`,
        sourceId: record.id,
        kind: "extract" as const,
        ordinal,
        text,
      }))
      .filter((chunk) => chunk.text.trim().length > 0);
  }
  if (record.type === "Claim") {
    const quote = record.body.replace(/^>\s*/gm, "").trim();
    const text = [record.title, quote].filter(Boolean).join("\n").trim();
    if (!text) {
      return [];
    }
    return [{ id: `${record.id}#quote`, sourceId: record.id, kind: "claim", ordinal: 0, text }];
  }
  return [];
}

export function isEmbeddablePath(path: string): boolean {
  return path.startsWith("extracts/") || path.startsWith("claims/");
}
