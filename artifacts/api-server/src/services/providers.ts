import { measureProvider } from "./metrics.ts";
import { pool } from "../tracking/store.ts";
export class ProviderError extends Error {
  retryAfterMs: number;
  constructor(message: string, retryAfterMs = 0) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}
export async function reserve(provider: string, rps: number) {
  const interval = Math.ceil(1000 / Math.max(0.1, rps));
  const r = await pool.query(
    `INSERT INTO cw_rate_limits(provider,next_at) VALUES($1,clock_timestamp()+$2*interval '1 millisecond')
 ON CONFLICT(provider) DO UPDATE SET next_at=GREATEST(cw_rate_limits.next_at,clock_timestamp())+$2*interval '1 millisecond'
 RETURNING GREATEST(0,extract(epoch FROM(next_at-$2*interval '1 millisecond'-clock_timestamp()))*1000) AS delay`,
    [provider, interval],
  );
  const wait = Number(r.rows[0].delay);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}
export async function request<T>(
  provider: string,
  url: string,
  options: RequestInit = {},
  rps = 2,
): Promise<T> {
  await reserve(provider, rps);
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    measureProvider(provider, performance.now() - started, false);
    throw new ProviderError(`${provider} connection failed`);
  }
  measureProvider(provider, performance.now() - started, response.ok);
  if (!response.ok) {
    const retry = response.headers.get("retry-after");
    const delay = retry
      ? Number.isFinite(Number(retry))
        ? Number(retry) * 1000
        : Math.max(0, Date.parse(retry) - Date.now())
      : 0;
    throw new ProviderError(`${provider} HTTP ${response.status}`, delay);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new ProviderError(`${provider} returned invalid JSON`);
  }
}
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}
