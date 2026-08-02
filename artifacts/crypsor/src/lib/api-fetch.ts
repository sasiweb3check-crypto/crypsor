/**
 * Shared fetch helper — timeout + consistent base URL so tab loads
 * survive Render cold starts instead of hanging forever.
 */
import { getApiBase } from "@/lib/api-base";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type ApiFetchInit = RequestInit & { timeoutMs?: number };

async function apiFetchOnce<T>(path: string, init?: ApiFetchInit): Promise<T> {
  const { timeoutMs = 28_000, signal: outerSignal, ...rest } = init ?? {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const onOuterAbort = () => ctrl.abort();
  if (outerSignal) {
    if (outerSignal.aborted) ctrl.abort();
    else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  }

  const url = `${getApiBase()}${path.replace(/^\//, "")}`;
  try {
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ApiError("Request timed out — API may be waking up", 0);
    }
    const msg = err instanceof Error ? err.message : "Failed to fetch";
    throw new ApiError(msg, 0);
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.status === 0) return true; // network / timeout / cold start
  return err.status === 502 || err.status === 503 || err.status === 504;
}

/** path like `api/ops/ping` (no leading slash required). Retries once on wake/network blips. */
export async function apiFetch<T>(path: string, init?: ApiFetchInit): Promise<T> {
  try {
    return await apiFetchOnce<T>(path, init);
  } catch (err) {
    if (!isRetryable(err) || init?.signal?.aborted) throw err;
    await new Promise((r) => setTimeout(r, 1_200));
    return apiFetchOnce<T>(path, init);
  }
}
