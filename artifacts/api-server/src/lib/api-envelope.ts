/**
 * Standard API envelope for production clients.
 * All Runner / Pro JSON responses should use these helpers.
 */

export type ApiMeta = {
  ts: string;
  version?: string;
  cache?: string;
  [key: string]: unknown;
};

export function apiOk<T>(data: T, meta: Omit<ApiMeta, "ts"> = {}) {
  return {
    ok: true as const,
    data,
    meta: {
      ts: new Date().toISOString(),
      version: "runner-v1",
      ...meta,
    },
  };
}

export function apiFail(error: string, code = "error", details?: unknown) {
  return {
    ok: false as const,
    error,
    code,
    details: details ?? null,
    meta: { ts: new Date().toISOString(), version: "runner-v1" },
  };
}
