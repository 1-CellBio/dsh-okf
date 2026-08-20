export type BiblioSource = "crossref" | "openalex";

export type BiblioLookup = {
  doi?: string;
  title?: string;
  year?: string;
};

export type BiblioHit = {
  doi?: string;
  title?: string;
  authors?: string[];
  venue?: string;
  published?: string;
  score: number;
  source: BiblioSource;
};

export type BiblioClient = {
  lookup(query: BiblioLookup): Promise<BiblioHit | undefined>;
};

export type BiblioSuggested = {
  doi?: string;
  title?: string;
  authors?: string[];
  venue?: string;
  published?: string;
};

export type BiblioFrontmatter = {
  status: "applied" | "suggested" | "skipped";
  source: BiblioSource;
  score: number;
  suggested?: BiblioSuggested;
};

export type BiblioFields = {
  title: string;
  doi?: string;
  authors?: string[];
  venue?: string;
  published?: string;
};
