/**
 * Settings client — always uses getApiBase() via apiFetch
 * (the generated api-client-react client misses the API host on static FE).
 */
import { apiFetch, ApiError } from "@/lib/api-fetch";

export type SettingRow = {
  id: number;
  key: string;
  value: string;
  updatedAt: string;
};

type Envelope<T> = { ok: boolean; data?: T; error?: string };

export type HeliusUsage = {
  keyConfigured: boolean;
  rpcOk: boolean;
  rpcError: string | null;
  rpcLatencyMs: number;
  slot: number | null;
  projectId: string | null;
  usage: {
    creditsRemaining: number | null;
    creditsUsed: number | null;
    creditsLimit: number | null;
    plan: string | null;
    cycleStart: string | null;
    cycleEnd: string | null;
    prepaidCreditsRemaining: number | null;
  } | null;
  usageError: string | null;
  checkedAt: string;
};

export const SETTINGS_KEY = ["settings"] as const;
export const HELIUS_USAGE_KEY = ["helius-usage"] as const;

export function fetchSettings() {
  return apiFetch<SettingRow[]>("api/settings", { timeoutMs: 55_000 });
}

export function upsertSetting(key: string, value: string) {
  return apiFetch<SettingRow>("api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
    timeoutMs: 55_000,
  });
}

export async function fetchHeliusUsage(): Promise<HeliusUsage> {
  const body = await apiFetch<Envelope<HeliusUsage> | HeliusUsage>(
    "api/settings/helius-usage",
    { timeoutMs: 55_000 },
  );
  if (body && typeof body === "object" && "ok" in body) {
    const env = body as Envelope<HeliusUsage>;
    if (!env.ok || env.data === undefined) {
      throw new ApiError(env.error || "Helius usage check failed", 0);
    }
    return env.data;
  }
  return body as HeliusUsage;
}

export function fmtCredits(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}
