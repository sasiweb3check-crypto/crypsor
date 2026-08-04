import { useEffect, useState } from "react";
import {
  Eye, EyeOff, KeyRound, ExternalLink, CheckCircle, Send, Gauge, RefreshCw,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { getApiBase } from "@/lib/api-base";
import {
  HELIUS_USAGE_KEY, SETTINGS_KEY,
  fetchHeliusUsage, fetchSettings, fmtCredits, upsertSetting,
} from "@/lib/settings-api";
import { Link } from "wouter";
import { cn } from "@/lib/utils";

export default function Settings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const apiBase = getApiBase();

  const settingsQ = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: fetchSettings,
    staleTime: 30_000,
    retry: 2,
  });

  const [heliusKey, setHeliusKey] = useState("");
  const [heliusProjectId, setHeliusProjectId] = useState("");
  const [showHelius, setShowHelius] = useState(false);
  const [heliusSaved, setHeliusSaved] = useState(false);
  const [telegramPush, setTelegramPush] = useState(true);
  const [checkUsage, setCheckUsage] = useState(false);

  useEffect(() => {
    const settings = settingsQ.data;
    if (!settings) return;
    const hKey = settings.find((s) => s.key === "helius_api_key");
    if (hKey) setHeliusKey(hKey.value);
    const proj = settings.find((s) => s.key === "helius_project_id");
    if (proj) setHeliusProjectId(proj.value);
    const tg = settings.find((s) => s.key === "telegram_push_enabled");
    if (tg) {
      const v = tg.value.trim().toLowerCase();
      setTelegramPush(v !== "false" && v !== "0" && v !== "off");
    }
  }, [settingsQ.data]);

  const usageQuery = useQuery({
    queryKey: HELIUS_USAGE_KEY,
    queryFn: fetchHeliusUsage,
    enabled: checkUsage,
    staleTime: 30_000,
    retry: 1,
  });

  const saveMut = useMutation({
    mutationFn: async () => {
      const key = heliusKey.trim();
      if (!key) throw new Error("Paste a Helius API key first");
      const jobs = [upsertSetting("helius_api_key", key)];
      // Skip empty project id — one less cold-start request
      if (heliusProjectId.trim()) {
        jobs.push(upsertSetting("helius_project_id", heliusProjectId.trim()));
      }
      await Promise.all(jobs);
    },
    onSuccess: () => {
      setHeliusSaved(true);
      toast({ title: "Saved", description: "Helius settings updated." });
      setTimeout(() => setHeliusSaved(false), 3000);
      void qc.invalidateQueries({ queryKey: SETTINGS_KEY });
      void qc.invalidateQueries({ queryKey: HELIUS_USAGE_KEY });
      setCheckUsage(true);
    },
    onError: (err) => {
      toast({
        title: "Failed to save",
        description: err instanceof Error ? err.message : `Check API at ${apiBase}`,
        variant: "destructive",
      });
    },
  });

  const tgMut = useMutation({
    mutationFn: (on: boolean) => upsertSetting("telegram_push_enabled", on ? "true" : "false"),
    onSuccess: (_d, on) => {
      toast({
        title: on ? "Telegram on" : "Telegram stopped",
        description: on
          ? "Alert pushes send when bot credentials are set."
          : "Push muted — desk still scores in-app.",
      });
      void qc.invalidateQueries({ queryKey: SETTINGS_KEY });
    },
    onError: (err, on) => {
      setTelegramPush(!on);
      toast({
        title: "Failed",
        description: err instanceof Error ? err.message : "Could not update",
        variant: "destructive",
      });
    },
  });

  const toggleTelegram = (on: boolean) => {
    setTelegramPush(on);
    tgMut.mutate(on);
  };

  const usage = usageQuery.data;
  const busy = saveMut.isPending || settingsQ.isLoading;

  return (
    <div className="desk-page desk-settings">
      <div className="desk-settings-head">
        <h1 className="desk-settings-title">Settings</h1>
        <p className="desk-settings-sub">Helius key · Telegram · API health</p>
      </div>

      {settingsQ.isError && (
        <div className="desk-empty">
          <p>Settings load failed</p>
          <p className="muted">API: <span className="font-mono-num">{apiBase}</span></p>
          <div className="desk-pager" style={{ paddingTop: 8 }}>
            <button type="button" className="desk-btn" onClick={() => void settingsQ.refetch()}>
              Retry
            </button>
            <Link href="/ops"><span className="desk-btn">Open Logs</span></Link>
          </div>
        </div>
      )}

      <section className="desk-panel">
        <div className="desk-panel-head">
          <Send className="w-4 h-4 text-[var(--cryp-accent)]" />
          <div className="min-w-0 flex-1">
            <div className="desk-panel-title">Telegram</div>
            <div className="desk-panel-sub">Alert + milestone push</div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={telegramPush}
            onClick={() => toggleTelegram(!telegramPush)}
            disabled={tgMut.isPending || settingsQ.isLoading}
            className={cn("desk-switch", telegramPush && "desk-switch-on")}
          >
            <span className="desk-switch-knob" />
          </button>
        </div>
        <p className="desk-panel-body">
          {telegramPush
            ? "Push is on. Stop anytime — desk still updates in-app."
            : "Push stopped. Tokens still score; nothing is sent to Telegram."}
          {" "}
          Health under{" "}
          <Link href="/ops"><span className="desk-link">Logs</span></Link>.
        </p>
      </section>

      <section className="desk-panel">
        <div className="desk-panel-head">
          <KeyRound className="w-4 h-4 text-[var(--cryp-accent)]" />
          <div>
            <div className="desk-panel-title">Helius</div>
            <div className="desk-panel-sub">API key · credit limit</div>
          </div>
        </div>

        <div className="desk-panel-body space-y-4">
          {settingsQ.isLoading ? (
            <div className="space-y-3">
              <div className="desk-skeleton h-9" />
              <div className="desk-skeleton h-9" />
            </div>
          ) : (
            <>
              <label className="desk-field">
                <span>Helius API Key</span>
                <div className="desk-field-row">
                  <input
                    type={showHelius ? "text" : "password"}
                    value={heliusKey}
                    onChange={(e) => setHeliusKey(e.target.value)}
                    placeholder="Enter your Helius API key"
                    className="desk-input"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowHelius((v) => !v)}
                    className="desk-icon-btn"
                    aria-label={showHelius ? "Hide key" : "Show key"}
                  >
                    {showHelius ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <span className="desk-field-hint">
                  Required for Solana wallet buys.{" "}
                  <a
                    href="https://www.helius.dev"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="desk-link inline-flex items-center gap-0.5"
                  >
                    helius.dev <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                </span>
              </label>

              <label className="desk-field">
                <span>Project ID <em>(credit limit)</em></span>
                <input
                  type="text"
                  value={heliusProjectId}
                  onChange={(e) => setHeliusProjectId(e.target.value)}
                  placeholder="UUID from Helius dashboard"
                  className="desk-input"
                  autoComplete="off"
                />
              </label>
            </>
          )}
        </div>

        <div className="desk-panel-actions">
          <button
            type="button"
            onClick={() => saveMut.mutate()}
            disabled={busy}
            className={cn("desk-btn desk-btn-primary", heliusSaved && "desk-btn-ok")}
          >
            {heliusSaved
              ? <><CheckCircle className="w-3.5 h-3.5" /> Saved</>
              : saveMut.isPending ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => {
              setCheckUsage(true);
              void usageQuery.refetch();
            }}
            disabled={settingsQ.isLoading || usageQuery.isFetching}
            className="desk-btn"
          >
            <Gauge className={cn("w-3.5 h-3.5", usageQuery.isFetching && "animate-spin")} />
            {usageQuery.isFetching ? "Checking…" : "Verify"}
          </button>
        </div>

        {checkUsage && (
          <div className="desk-panel-body pt-0 space-y-2">
            {usageQuery.isError && (
              <p className="text-[12px] text-[var(--cryp-loss)]">
                {usageQuery.error instanceof Error
                  ? usageQuery.error.message
                  : "Usage check failed"}
              </p>
            )}
            {usage && (
              <div className={cn("desk-usage", usage.rpcOk ? "is-ok" : "is-bad")}>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] font-bold uppercase tracking-wider">
                    Key {usage.rpcOk ? "valid" : "invalid"}
                    <span className="font-mono-num font-normal opacity-70">
                      {" · "}{usage.rpcLatencyMs}ms
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void usageQuery.refetch()}
                    className="desk-icon-btn"
                    aria-label="Refresh usage"
                  >
                    <RefreshCw className={cn("w-3.5 h-3.5", usageQuery.isFetching && "animate-spin")} />
                  </button>
                </div>
                {usage.rpcError && (
                  <p className="text-[11px] text-[var(--cryp-loss)] mt-1">{usage.rpcError}</p>
                )}
                {usage.usage ? (
                  <div className="grid grid-cols-2 gap-2 pt-2">
                    <div>
                      <div className="desk-metric-label">Remaining</div>
                      <div className="font-mono-num text-[15px] font-bold text-[var(--cryp-accent)]">
                        {fmtCredits(usage.usage.creditsRemaining)}
                      </div>
                    </div>
                    <div>
                      <div className="desk-metric-label">Limit</div>
                      <div className="font-mono-num text-[15px] font-bold">
                        {fmtCredits(usage.usage.creditsLimit)}
                      </div>
                    </div>
                    <div>
                      <div className="desk-metric-label">Used</div>
                      <div className="font-mono-num text-[13px]">
                        {fmtCredits(usage.usage.creditsUsed)}
                      </div>
                    </div>
                    <div>
                      <div className="desk-metric-label">Plan</div>
                      <div className="text-[13px] capitalize">{usage.usage.plan ?? "—"}</div>
                    </div>
                  </div>
                ) : (
                  <p className="text-[11px] text-[var(--cryp-mute)] mt-1">
                    {usage.usageError ?? "Save Project ID to see credit limit"}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
