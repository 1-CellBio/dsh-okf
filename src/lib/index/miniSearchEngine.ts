import MiniSearch from "minisearch";
import type { SearchEngine, SearchHit } from "./search";

export function createMiniSearchEngine(
  docs: { id: string; type: string; title: string; body: string }[],
): SearchEngine {
  const bodies = new Map(docs.map((doc) => [doc.id, doc.body]));
  const search = new MiniSearch({
    fields: ["title", "body"],
    storeFields: ["id", "type"],
    idField: "id",
  });
  search.addAll(docs);
  return {
    search(query: string, options?: { prefix?: boolean; fuzzy?: number }): SearchHit[] {
      try {
        return search.search(query, {
          prefix: options?.prefix ?? true,
          fuzzy: options?.fuzzy ?? 0.2,
        }).map((hit) => ({ id: String(hit.id), score: hit.score }));
      } catch {
        return [];
      }
    },
    getBody(id: string): string | undefined {
      return bodies.get(id);
    },
  };
}
