export type OkfStatus = "draft" | "stable" | "deprecated";

export type Frontmatter = Record<string, unknown>;

export type ParsedDocument = {
  frontmatter: Frontmatter;
  body: string;
};

export type ConceptRecord = {
  id: string;
  path: string;
  type: string;
  title?: string;
  published?: string;
  tags: string[];
  status: OkfStatus;
  verifiedHuman: boolean;
  paper?: string;
  doi?: string;
  outgoing: string[];
  body: string;
  confidence?: string;
  stance?: string;
};
