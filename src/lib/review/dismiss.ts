import type { FileStore } from "@/lib/fs/types";
import { utf8Decode } from "@/lib/fs/types";
import { okfCachePath } from "@/lib/okf/cache";

export const REVIEW_DISMISS_PATH = okfCachePath("review-dismissed.json");

export function reviewPairKey(left: string, right: string): string {
  return [left, right].sort().join("|");
}

export async function loadDismissedPairs(store: FileStore): Promise<Set<string>> {
  if (!(await store.exists(REVIEW_DISMISS_PATH))) {
    return new Set();
  }
  try {
    const parsed = JSON.parse(utf8Decode(await store.read(REVIEW_DISMISS_PATH))) as { pairs?: unknown };
    const pairs = Array.isArray(parsed.pairs)
      ? parsed.pairs.filter((item): item is string => typeof item === "string" && item.includes("|"))
      : [];
    return new Set(pairs);
  } catch {
    return new Set();
  }
}

export async function dismissReviewPair(store: FileStore, left: string, right: string): Promise<void> {
  const pairs = await loadDismissedPairs(store);
  pairs.add(reviewPairKey(left, right));
  await store.write(
    REVIEW_DISMISS_PATH,
    `${JSON.stringify({ generated: new Date().toISOString(), pairs: [...pairs].sort() }, null, 2)}\n`,
  );
}
