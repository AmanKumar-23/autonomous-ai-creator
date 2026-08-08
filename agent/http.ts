/**
 * The only place discovery touches the network.
 *
 * Contract: never throw. Callers get text or null, so one flaky source can
 * never take down a whole cycle. Failures are described well enough for the
 * /status page to show what went wrong.
 */

export const DEFAULT_TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 600;

export interface FetchResult {
  ok: boolean;
  body: string | null;
  error: string | null;
  attempts: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One retry with a short backoff. Two attempts is the right budget: a cycle
 * runs every couple of hours, so a source that is down stays down, and waiting
 * longer only delays the other source's results.
 */
export async function fetchText(
  url: string,
  options: { timeoutMs?: number; retries?: number } = {},
): Promise<FetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = (options.retries ?? 1) + 1;
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": "autonomous-ai-creator (hackathon project)" },
      });

      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        // 4xx is a bad request on our side; retrying will not fix it.
        if (response.status >= 400 && response.status < 500) {
          return { ok: false, body: null, error: lastError, attempts: attempt };
        }
      } else {
        return { ok: true, body: await response.text(), error: null, attempts: attempt };
      }
    } catch (error) {
      lastError =
        error instanceof Error
          ? error.name === "TimeoutError" || error.name === "AbortError"
            ? `timeout after ${timeoutMs}ms`
            : error.message
          : String(error);
    }

    if (attempt < maxAttempts) await sleep(RETRY_DELAY_MS * attempt);
  }

  return { ok: false, body: null, error: lastError, attempts: maxAttempts };
}

/** Parses JSON without throwing. Malformed bodies become null. */
export function parseJson<T>(body: string | null): T | null {
  if (!body) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}
