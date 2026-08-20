/** Chat completions can stream long JSON and vision batches; keep a generous ceiling. */
export const LLM_TIMEOUT_MS = 120_000;
export const EMBED_TIMEOUT_MS = 60_000;

/** fetch with a hard timeout. On abort, rejects with a "timed out" message so
 * callers that retry on timeout wording (e.g. vision extraction) pick it up. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`request timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
