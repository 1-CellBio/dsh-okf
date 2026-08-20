export type ReviewKind =
  | "missing_published"
  | "missing_doi"
  | "low_confidence_biblio"
  | "disputed_claim"
  | "extracted_claim"
  | "near_duplicate"
  | "merge_conflict"
  | "draft";

export type ReviewItem = {
  id: string;
  kind: ReviewKind;
  path: string;
  title: string;
  detail: string;
  otherPath?: string;
  otherTitle?: string;
  paper?: string;
  count?: number;
};

export type OrganizeCard = {
  id: string;
  path: string;
  title: string;
  status: string;
  excerpt: string;
  links: string[];
};

export type OrganizeSnapshot = {
  review: {
    total: number;
    actionTotal: number;
    backlogTotal: number;
    counts: Record<ReviewKind, number>;
    items: ReviewItem[];
    truncated: boolean;
  };
  notes: OrganizeCard[];
  questions: OrganizeCard[];
  surveys: OrganizeCard[];
  manuscripts: string[];
};

export type WorkbenchPage = {
  id: string;
  path: string;
  type?: string;
  title?: string;
  status?: string;
  body: string;
  truncated: boolean;
  outgoing: string[];
};

export const REVIEW_KINDS: ReviewKind[] = [
  "missing_published",
  "missing_doi",
  "low_confidence_biblio",
  "disputed_claim",
  "extracted_claim",
  "near_duplicate",
  "merge_conflict",
  "draft",
];

export const REVIEW_ACTION_KINDS: ReviewKind[] = [
  "merge_conflict",
  "disputed_claim",
  "near_duplicate",
  "missing_published",
  "low_confidence_biblio",
];

export const REVIEW_BACKLOG_KINDS: ReviewKind[] = [
  "extracted_claim",
  "missing_doi",
  "draft",
];

export function isReviewAction(kind: ReviewKind): boolean {
  return REVIEW_ACTION_KINDS.includes(kind);
}

export type CoverageSnapshot = {
  years: string[];
  topics: Array<{
    id: string;
    title: string;
    paperCount: number;
    missingYears: string[];
    counts: number[];
  }>;
  gaps: Array<{
    id: string;
    kind: string;
    title: string;
    topicId?: string;
    year?: string;
    methodId?: string;
    paperId?: string;
  }>;
};
