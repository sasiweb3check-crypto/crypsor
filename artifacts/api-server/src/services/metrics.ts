export const apiMetrics = {
  requests: 0,
  errors: 0,
  totalMs: 0,
  maxMs: 0,
  buckets: { under50: 0, under250: 0, under1000: 0, over1000: 0 },
};
export const providerMetrics: Record<
  string,
  {
    requests: number;
    errors: number;
    totalMs: number;
    lastMs: number;
    lastSuccessAt: string | null;
    lastErrorAt: string | null;
  }
> = {};
export function measureProvider(provider: string, ms: number, ok: boolean) {
  const m = (providerMetrics[provider] ??= {
    requests: 0,
    errors: 0,
    totalMs: 0,
    lastMs: 0,
    lastSuccessAt: null,
    lastErrorAt: null,
  });
  m.requests++;
  m.totalMs += ms;
  m.lastMs = ms;
  if (ok) m.lastSuccessAt = new Date().toISOString();
  else {
    m.errors++;
    m.lastErrorAt = new Date().toISOString();
  }
}
