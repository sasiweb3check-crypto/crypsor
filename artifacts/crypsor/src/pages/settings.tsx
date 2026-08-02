import { useState, useEffect } from "react";
import {
  Eye, EyeOff, KeyRound, ExternalLink, CheckCircle, Send, Gauge, RefreshCw,
} from "lucide-react";
import { useGetSettings, useUpsertSetting } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { getApiBase } from "@/lib/api-base";
import { apiFetch, ApiError } from "@/lib/api-fetch";
import { Link } from "wouter";
import { cn } from "@/lib/utils";

type HeliusUsage = {
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

type Envelope<T> = { ok: boolean; data?: T; error?: string };

async function fetchHeliusUsage(): Promise<HeliusUsage> {
  const body = await apiFetch<Envelope<HeliusUsage> | HeliusUsage>(
    "api/settings/helius-usage",
    { timeoutMs: 20_000 },
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

function fmtCredits(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

export default function Settings() {
  const { data: settings, isLoading, error: settingsError, refetch } = useGetSettings();
  const upsertSetting = useUpsertSetting();
  const { toast } = useToast();

  const [heliusKey, setHeliusKey] = useState("");
  const [heliusProjectId, setHeliusProjectId] = useState("");
  const [showHelius, setShowHelius] = useState(false);
  const [heliusSaved, setHeliusSaved] = useState(false);
  const [telegramPush, setTelegramPush] = useState(true);
  const [checkUsage, setCheckUsage] = useState(false);

  const apiBase = getApiBase();

  useEffect(() => {
    if (settings) {
      const hKey = settings.find(s => s.key === "helius_api_key");
      if (hKey) setHeliusKey(hKey.value);
      const proj = settings.find(s => s.key === "helius_project_id");
      if (proj) setHeliusProjectId(proj.value);
      const tg = settings.find(s => s.key === "telegram_push_enabled");
      if (tg) {
        const v = tg.value.trim().toLowerCase();
        setTelegramPush(v !== "false" && v !== "0" && v !== "off");
      }
    }
  }, [settings]);

  const usageQuery = useQuery({
    queryKey: ["helius-usage"],
    queryFn: fetchHeliusUsage,
    enabled: checkUsage,
    staleTime: 30_000,
    retry: 1,
  });

  const saveHelius = () => {
    const jobs = [
      upsertSetting.mutateAsync({ data: { key: "helius_api_key", value: heliusKey.trim() } }),
      upsertSetting.mutateAsync({
        data: { key: "helius_project_id", value: heliusProjectId.trim() },
      }),
    ];
    Promise.all(jobs)
      .then(() => {
        setHeliusSaved(true);
        toast({ title: "Saved", description: "Helius settings updated." });
        setTimeout(() => setHeliusSaved(false), 3000);
        if (checkUsage) void usageQuery.refetch();
      })
      .catch((err) => toast({
        title: "Failed to save",
        description: err instanceof Error ? err.message : `Check API at ${apiBase}`,
        variant: "destructive",
      }));
  };

  const toggleTelegram = (on: boolean) => {
    setTelegramPush(on);
    upsertSetting.mutate(
      { data: { key: "telegram_push_enabled", value: on ? "true" : "false" } },
      {
        onSuccess: () => {
          toast({
            title: on ? "Telegram on" : "Telegram stopped",
            description: on
              ? "ENTRY / milestone pushes will send when credentials are set."
              : "Push muted — desk still scores in-app.",
          });
        },
        onError: (err) => {
          setTelegramPush(!on);
          toast({
            title: "Failed",
            description: err instanceof Error ? err.message : "Could not update",
            variant: "destructive",
          });
        },
      },
    );
  };

  const usage = usageQuery.data;

  return (
    <div className="space-y-4 px-4 py-5 max-w-lg mx-auto w-full">
      <div>
        <h1 className="font-display text-[18px] font-extrabold tracking-tight text-[var(--cryp-text)]">
          Settings
        </h1>
        <p className="text-[var(--cryp-mute)] text-[12px] mt-1">
          Helius limits · Telegram stop · pipeline keys
        </p>
      </div>

      {settingsError && (
        <div
          className="px-3 py-2 rounded-xl text-[11px] text-[var(--cryp-loss)]"
          style={{ border: "1px solid rgba(232,93,93,0.35)", background: "rgba(232,93,93,0.08)" }}
        >
          Settings load failed. API: <span className="font-mono">{apiBase}</span>
          {" · "}
          <button type="button" className="underline" onClick={() => void refetch()}>Retry</button>
          {" · "}
          <Link href="/ops"><span className="underline cursor-pointer">Open Logs</span></Link>
        </div>
      )}

      {/* Telegram stop */}
      <div className="call-card overflow-hidden !p-0">
        <div className="px-5 py-4 flex items-center gap-3" style={{ borderBottom: "1px solid var(--cryp-line)" }}>
          <Send className="w-4 h-4 text-[var(--cryp-teal)]" />
          <div className="flex-1 min-w-0">
            <div className="text-[var(--cryp-text)] text-sm font-bold tracking-wide">Telegram</div>
            <div className="text-[10px] text-[var(--cryp-mute)] tracking-widest uppercase mt-0.5">
              ENTRY + milestone push
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={telegramPush}
            onClick={() => toggleTelegram(!telegramPush)}
            disabled={upsertSetting.isPending || isLoading}
            className={cn(
              "relative w-11 h-6 rounded-full transition-colors shrink-0",
              telegramPush ? "bg-[var(--cryp-teal)]" : "bg-[var(--cryp-elevated)] border border-[var(--cryp-line)]",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform",
                telegramPush && "translate-x-5",
              )}
            />
          </button>
        </div>
        <div className="px-5 py-3 text-[12px] text-[var(--cryp-mute)] leading-relaxed">
          {telegramPush
            ? "Push is on. Stop anytime — Waiting / Best still update in-app."
            : "Push stopped. Tokens still score on the desk; nothing is sent to Telegram."}
          {" "}
          Health under{" "}
          <Link href="/ops"><span className="text-[var(--cryp-mint)] underline cursor-pointer">Logs</span></Link>.
        </div>
      </div>

      {/* Helius */}
      <div className="call-card overflow-hidden !p-0">
        <div className="px-5 py-4 flex items-center gap-3" style={{ borderBottom: "1px solid var(--cryp-line)" }}>
          <KeyRound className="w-4 h-4 text-[var(--cryp-teal)]" />
          <div>
            <div className="text-[var(--cryp-text)] text-sm font-bold tracking-wide">Helius</div>
            <div className="text-[10px] text-[var(--cryp-mute)] tracking-widest uppercase mt-0.5">
              API key · credit limit
            </div>
          </div>
        </div>

        <div className="px-5 py-5 space-y-5">
          {isLoading ? (
            <div className="space-y-3 animate-pulse">
              <div className="h-3 w-32 bg-[var(--cryp-elevated)]" />
              <div className="h-9 bg-[var(--cryp-elevated)]" />
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <label className="text-[10px] text-[var(--cryp-mute)] uppercase tracking-widest block">
                  Helius API Key
                </label>
                <div className="relative">
                  <input
                    type={showHelius ? "text" : "password"}
                    value={heliusKey}
                    onChange={e => setHeliusKey(e.target.value)}
                    placeholder="Enter your Helius API key"
                    className="w-full h-10 px-3 pr-10 text-[12px] rounded-xl bg-[var(--cryp-ink)] border border-[var(--cryp-line)] text-[var(--cryp-text)] placeholder-[var(--cryp-mute)] focus:outline-none focus:border-[var(--cryp-teal)] font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowHelius(!showHelius)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]"
                  >
                    {showHelius ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
                <p className="text-[11px] text-[var(--cryp-mute)]">
                  Required for Solana wallet multi-buys.{" "}
                  <a
                    href="https://www.helius.dev"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--cryp-mint)] hover:underline inline-flex items-center gap-0.5"
                  >
                    helius.dev <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] text-[var(--cryp-mute)] uppercase tracking-widest block">
                  Project ID <span className="normal-case tracking-normal opacity-70">(for credit limit)</span>
                </label>
                <input
                  type="text"
                  value={heliusProjectId}
                  onChange={e => setHeliusProjectId(e.target.value)}
                  placeholder="UUID from Helius dashboard (top-left)"
                  className="w-full h-10 px-3 text-[12px] rounded-xl bg-[var(--cryp-ink)] border border-[var(--cryp-line)] text-[var(--cryp-text)] placeholder-[var(--cryp-mute)] focus:outline-none focus:border-[var(--cryp-teal)] font-mono"
                />
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-4 flex flex-wrap items-center gap-2" style={{ borderTop: "1px solid var(--cryp-line)" }}>
          <button
            onClick={saveHelius}
            disabled={upsertSetting.isPending || isLoading}
            className={`flex items-center gap-2 h-9 px-4 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-colors disabled:opacity-40 ${
              heliusSaved
                ? "bg-[rgba(62,207,142,0.14)] text-[var(--cryp-gain)]"
                : "bg-[var(--cryp-teal)] text-[var(--cryp-ink)]"
            }`}
          >
            {heliusSaved
              ? <><CheckCircle className="w-3.5 h-3.5" /> Saved</>
              : upsertSetting.isPending ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => {
              setCheckUsage(true);
              void usageQuery.refetch();
            }}
            disabled={isLoading || usageQuery.isFetching}
            className="flex items-center gap-2 h-9 px-4 rounded-xl text-[11px] font-bold uppercase tracking-widest border border-[var(--cryp-line)] text-[var(--cryp-mint)] disabled:opacity-40"
          >
            <Gauge className={cn("w-3.5 h-3.5", usageQuery.isFetching && "animate-spin")} />
            {usageQuery.isFetching ? "Checking…" : "Verify limit"}
          </button>
        </div>

        {checkUsage && (
          <div className="px-5 pb-5 space-y-2">
            {usageQuery.isError && (
              <div className="text-[11px] text-[var(--cryp-loss)]">
                {usageQuery.error instanceof Error
                  ? usageQuery.error.message
                  : "Usage check failed"}
              </div>
            )}
            {usage && (
              <div
                className="rounded-xl px-3 py-3 space-y-2"
                style={{
                  border: `1px solid ${usage.rpcOk ? "rgba(62,207,142,0.3)" : "rgba(232,93,93,0.3)"}`,
                  background: usage.rpcOk ? "rgba(62,207,142,0.06)" : "rgba(232,93,93,0.06)",
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] font-bold uppercase tracking-widest"
                    style={{ color: usage.rpcOk ? "var(--cryp-gain)" : "var(--cryp-loss)" }}
                  >
                    Key {usage.rpcOk ? "valid" : "invalid"}
                    <span className="font-mono-num font-normal opacity-70">
                      {" · "}{usage.rpcLatencyMs}ms
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void usageQuery.refetch()}
                    className="text-[var(--cryp-mute)]"
                    aria-label="Refresh usage"
                  >
                    <RefreshCw className={cn("w-3.5 h-3.5", usageQuery.isFetching && "animate-spin")} />
                  </button>
                </div>
                {usage.rpcError && (
                  <div className="text-[11px] text-[var(--cryp-loss)]">{usage.rpcError}</div>
                )}
                {usage.usage ? (
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <div>
                      <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">Remaining</div>
                      <div className="font-mono-num text-[15px] font-bold text-[var(--cryp-mint)]">
                        {fmtCredits(usage.usage.creditsRemaining)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">Limit</div>
                      <div className="font-mono-num text-[15px] font-bold text-[var(--cryp-text)]">
                        {fmtCredits(usage.usage.creditsLimit)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">Used</div>
                      <div className="font-mono-num text-[13px] text-[var(--cryp-text)]">
                        {fmtCredits(usage.usage.creditsUsed)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">Plan</div>
                      <div className="text-[13px] text-[var(--cryp-text)] capitalize">
                        {usage.usage.plan ?? "—"}
                      </div>
                    </div>
                    {(usage.usage.cycleStart || usage.usage.cycleEnd) && (
                      <div className="col-span-2 text-[10px] text-[var(--cryp-mute)]">
                        Cycle {usage.usage.cycleStart ?? "?"} → {usage.usage.cycleEnd ?? "?"}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-[11px] text-[var(--cryp-mute)]">
                    {usage.usageError ?? "Save Project ID to see credit limit"}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
