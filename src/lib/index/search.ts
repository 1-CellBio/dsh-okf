export type SearchHit = {
  id: string;
  score: number;
};

export type SearchEngine = {
  search(query: string, options?: { prefix?: boolean; fuzzy?: number }): SearchHit[];
  getBody(id: string): string | undefined;
  /** Release any held resources (e.g. an open sql.js database). */
  dispose?(): void;
};
