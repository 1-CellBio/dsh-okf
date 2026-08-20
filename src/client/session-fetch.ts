const FETCH_TIMEOUT_MS = 30_000;

/** fetchJson with a timeout and correct error reporting for non-JSON bodies. */
export async function fetchOkfJson<T>(
  path: string,
  sessionId: string,
  query: Record<string, string> = {},
): Promise<T> {
  const params = new URLSearchParams({ session: sessionId, ...query });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${path}?${params.toString()}`, { signal: controller.signal });
    if (!response.ok) {
      // Read the body as text first; the server may return a non-JSON error page.
      const body = await response.text();
      let message = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(body) as { error?: string };
        if (parsed?.error) {
          message = parsed.error;
        }
      } catch {
        // Not JSON — keep the status-based message.
      }
      throw new Error(message);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}
