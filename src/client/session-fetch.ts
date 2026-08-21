const FETCH_TIMEOUT_MS = 30_000;

/** fetchJson with a timeout and correct error reporting for non-JSON bodies. */
export async function fetchOkfJson<T>(
  path: string,
  sessionId: string,
  query: Record<string, string> = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<T> {
  return okfRequest<T>(path, sessionId, query, {}, timeoutMs);
}

export async function postOkfJson<T>(
  path: string,
  sessionId: string,
  body: Record<string, string>,
): Promise<T> {
  return okfRequest<T>(path, sessionId, {}, { method: "POST", body: JSON.stringify(body) });
}

async function okfRequest<T>(
  path: string,
  sessionId: string,
  query: Record<string, string>,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<T> {
  const params = new URLSearchParams({ session: sessionId, ...query });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${path}?${params.toString()}`, {
      ...init,
      signal: controller.signal,
      headers: init.body
        ? { "Content-Type": "application/json", ...(init.headers ?? {}) }
        : init.headers,
    });
    if (!response.ok) {
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
