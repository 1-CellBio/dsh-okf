const MAX_CONCURRENCY = 32;

export function parseConcurrency(raw: string | undefined, fallback = 4): number {
  if (raw == null || raw.trim() === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    return fallback;
  }
  return Math.min(MAX_CONCURRENCY, Math.floor(n));
}

/** Run `worker` over `items` with a fixed worker pool. Order of results matches input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) {
    return results;
  }
  const limit = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  let next = 0;
  let aborted = false;
  async function run(): Promise<void> {
    while (!aborted) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      try {
        results[index] = await worker(items[index] as T, index);
      } catch (error) {
        // Stop handing out remaining items; in-flight workers finish but no new
        // work is picked up after the first failure.
        aborted = true;
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, () => run()));
  return results;
}
