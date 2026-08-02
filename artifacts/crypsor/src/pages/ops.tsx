/**
 * Ops — lightweight pipeline visibility (Helius buys, scan delay, Telegram, Pro blockers).
 * Polls /api/ops/summary + /api/ops/log — no heavy DB writes on the hot path.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Activity, AlertTriangle, Wifi, WifiOff, Send, Zap, RefreshCw, Hourglass,
} from "lucide-react";
import { getApiBase } from "@/lib/api-base";
import {
  OPS_GMGN_KEY,
  OPS_LOG_KEY,
  OPS_PING_KEY,
  OPS_SUMMARY_KEY,
  fetchOpsGmgn,
  fetchOpsLog,
  fetchOpsPing,
  fetchOpsSummary,
  type OpsKind,
  type OpsLevel,
} from "@/lib/ops-api";
import { CALLS_WAITING_KEY, fetchCallsWaiting } from "@/lib/calls-api";
import { cn, formatTimeAgo, safeSymbol } from "@/lib/utils";

const API_LABEL = getApiBase().replace(/\/$/, "") || "(same origin)";

function levelColor(level: OpsLevel) {
  if (level === "error") return "#ef4444";
  if (level === "warn") return "#f59e0b";
  return "#8b949e";
}

function Pill({
  tone, label, sub,
}: { tone: "ok" | "warn" | "bad" | "idle"; label: string; sub?: string }) {
  const color =
    tone === "ok" ? "#22c55e"
      : tone === "warn" ? "#f59e0b"
        : tone === "bad" ? "#ef4444"
          : "#8b949e";
  return (
    <div
      className="flex flex-col gap-0.5 px-3 py-2 rounded-lg min-w-[110px]"
      style={{ background: `${color}12`, border: `1px solid ${color}35` }}
    >
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
        <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color }}>{label}</span>
      </div>
      {sub && <span className="text-[9px] text-[#8b949e] pl-3">{sub}</span>}
    </div>
  );
}

function WaitingQueuePanel({ count }: { count: number }) {
  const { data, isLoading } = useQuery({
    queryKey: CALLS_WAITING_KEY,
    queryFn: () => fetchCallsWaiting(12),
    refetchInterval: 15_000,
    staleTime: 8_000,
  });
  const cards = data?.cards ?? [];

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-widest text-[#f59e0b]">
          <Hourglass className="w-3 h-3" />
          Waiting · {count} pending first call{count === 1 ? "" : "s"}
        </div>
        <Link href="/?mode=waiting">
          <span className="text-[9px] uppercase tracking-widest text-[#8b949e] hover:text-[#f59e0b] cursor-pointer">
            Full list →
          </span>
        </Link>
      </div>
      <div
        className="rounded-xl divide-y overflow-hidden"
        style={{ border: "1px solid #f59e0b35", background: "rgba(245,158,11,0.04)" }}
      >
        {isLoading && cards.length === 0 && (
          <div className="px-3 py-4 text-[10px] text-[#484f58] uppercase tracking-widest">
            Loading queue…
          </div>
        )}
        {!isLoading && cards.length === 0 && (
          <div className="px-3 py-4 text-[10px] text-[#484f58] uppercase tracking-widest">
            Queue empty
          </div>
        )}
        {cards.slice(0, 8).map(c => (
          <Link key={c.id} href={`/calls/${c.id}`}>
            <div className="flex items-start gap-2 px-3 py-2.5 cursor-pointer hover:bg-[rgba(245,158,11,0.08)]">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[12px] font-bold text-[#e6edf3]">
                    ${safeSymbol(c.symbol, c.address)}
                  </span>
                  <span className="text-[9px] font-bold uppercase tracking-wider text-[#f59e0b]">
                    {c.runnerLabel ?? c.runnerPhase ?? "hold"}
                  </span>
                  {c.snapCount != null && (
                    <span className="text-[9px] font-mono text-[#8b949e]">
                      snaps {c.snapCount}/5
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-[#f59e0b]/90 mt-0.5 truncate">
                  {c.holdReason ?? c.blockers?.[0] ?? "Held for ENTRY gates"}
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export default function OpsPage() {
  const [kind, setKind] = useState<OpsKind>("all");

  const {
    data: summary,
    refetch: refetchSummary,
    isFetching: fetchingSummary,
    isPending: pendingSummary,
    isError: summaryError,
  } = useQuery({
    queryKey: OPS_SUMMARY_KEY,
    queryFn: fetchOpsSummary,
    refetchInterval: 12_000,
    staleTime: 8_000,
    placeholderData: keepPreviousData,
  });

  const {
    data: logData,
    refetch: refetchLog,
    isFetching: fetchingLog,
    isPending: pendingLog,
    isError: logError,
    isPlaceholderData: logPlaceholder,
  } = useQuery({
    queryKey: OPS_LOG_KEY(kind),
    queryFn: () => fetchOpsLog(kind),
    refetchInterval: 12_000,
    staleTime: 8_000,
    placeholderData: keepPreviousData,
  });

  const {
    data: ping,
    error: pingError,
    isPending: pendingPing,
    isError: isPingError,
    isFetching: fetchingPing,
  } = useQuery({
    queryKey: OPS_PING_KEY,
    queryFn: fetchOpsPing,
    refetchInterval: 20_000,
    staleTime: 15_000,
    retry: 3,
    placeholderData: keepPreviousData,
  });

  // Heavy probe — wait until ping succeeds so cold-start doesn't stampede GMGN
  const {
    data: gmgnCheck,
    refetch: refetchGmgn,
    isFetching: fetchingGmgn,
    isPending: pendingGmgn,
    isError: gmgnError,
  } = useQuery({
    queryKey: OPS_GMGN_KEY,
    queryFn: fetchOpsGmgn,
    enabled: Boolean(ping?.ok),
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: 1,
  });

  const gmgnResults = gmgnCheck?.scrape?.results ?? gmgnCheck?.results ?? [];

  const events = logData?.events ?? [];
  const blockers = summary?.blockers ?? [];

  const kinds: OpsKind[] = useMemo(
    () => ["all", "helius", "wallet_buy", "scan", "pro_qualify", "cto", "telegram", "blocker", "api"],
    [],
  );

  const pingTone: "ok" | "warn" | "bad" | "idle" =
    ping?.ok ? "ok"
      : pendingPing || fetchingPing ? "idle"
        : isPingError ? "bad"
          : "idle";

  const pingColor =
    pingTone === "ok" ? "#22c55e"
      : pingTone === "bad" ? "#ef4444"
        : "#8b949e";

  const gmgnTone: "ok" | "warn" | "bad" | "idle" =
    !ping?.ok ? "idle"
      : pendingGmgn || (fetchingGmgn && !gmgnCheck) ? "idle"
        : gmgnError ? "bad"
          : gmgnCheck?.ok ? "ok"
            : gmgnCheck ? "bad"
              : "idle";

  const gmgnColor =
    gmgnTone === "ok" ? "var(--cryp-mint)"
      : gmgnTone === "bad" ? "var(--cryp-loss)"
        : "var(--cryp-mute)";

  return (
    <div className="flex flex-col gap-3 px-3 py-3 md:px-6 md:py-5 max-w-3xl mx-auto w-full">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4" style={{ color: "var(--cryp-teal)" }} />
            <h1 className="font-display text-[13px] font-black uppercase tracking-widest text-[var(--cryp-text)]">Logs</h1>
          </div>
          <p className="text-[9px] text-[#484f58] mt-0.5">
            Wallet buys · Helius · Pro qualify · Telegram — lightweight ring log
          </p>
        </div>
        <button
          type="button"
          onClick={() => { void refetchSummary(); void refetchLog(); }}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-widest border border-[#30363d] text-[#8b949e] hover:text-[#f59e0b] hover:border-[#f59e0b]/40"
        >
          <RefreshCw className={cn("w-3 h-3", (fetchingSummary || fetchingLog) && "animate-spin")} />
          Refresh
        </button>
      </div>

      {/* Inventory — wallet buys / tokens in DB */}
      <div
        className="grid grid-cols-2 sm:grid-cols-4 gap-2 px-3 py-3"
        style={{ background: "rgba(61,154,139,0.06)", border: "1px solid rgba(61,154,139,0.18)" }}
      >
        {[
          { l: "Tokens tracked", v: summary?.inventory?.tokensTracked ?? (pendingSummary ? "…" : "—") },
          { l: "Tokens active", v: summary?.inventory?.tokensActive ?? (pendingSummary ? "…" : "—") },
          { l: "Wallet buys", v: summary?.inventory?.buysTotal ?? summary?.scan.totalBuysAllTime ?? (pendingSummary ? "…" : "—") },
          { l: "Wallets", v: summary?.inventory?.walletsTracked ?? summary?.scan.walletsTracked ?? (pendingSummary ? "…" : "—") },
        ].map(x => (
          <div key={x.l}>
            <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">{x.l}</div>
            <div className="font-mono-num text-lg font-bold text-[var(--cryp-mint)] mt-0.5">{x.v}</div>
          </div>
        ))}
      </div>

      {/* API reachability — idle (grey) while loading, red only after real failure */}
      <div
        className="px-3 py-2 rounded-lg text-[10px]"
        style={{
          background: `${pingColor}12`,
          border: `1px solid ${pingColor}35`,
          color: pingColor,
        }}
      >
        {ping?.ok
          ? `API reachable · ${API_LABEL} · ping ${formatTimeAgo(ping.ts) || "now"}`
          : pendingPing || fetchingPing
            ? `Connecting to API · ${API_LABEL} — waking host if cold…`
            : `API unreachable — ${pingError instanceof Error ? pingError.message : "Failed to fetch"}. Base: ${API_LABEL}`}
      </div>

      {/* GMGN from deployed API */}
      <div
        className="px-3 py-2.5 space-y-1.5"
        style={{
          background: gmgnTone === "ok"
            ? "rgba(61,154,139,0.08)"
            : gmgnTone === "bad"
              ? "rgba(232,93,93,0.08)"
              : "rgba(122,143,153,0.08)",
          border: `1px solid ${
            gmgnTone === "ok"
              ? "rgba(61,154,139,0.25)"
              : gmgnTone === "bad"
                ? "rgba(232,93,93,0.25)"
                : "rgba(122,143,153,0.25)"
          }`,
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] font-bold uppercase tracking-widest" style={{ color: gmgnColor }}>
            {!ping?.ok
              ? "GMGN waiting for API…"
              : pendingGmgn || (fetchingGmgn && !gmgnCheck)
                ? "GMGN checking…"
                : gmgnError
                  ? "GMGN check failed"
                  : gmgnCheck?.ok
                    ? "GMGN reachable"
                    : gmgnCheck
                      ? "GMGN blocked / failing"
                      : "GMGN idle"}
            {gmgnCheck?.latencyMs != null && (
              <span className="font-mono-num font-normal opacity-70"> · {gmgnCheck.latencyMs}ms</span>
            )}
          </div>
          <button
            type="button"
            onClick={() => void refetchGmgn()}
            disabled={!ping?.ok}
            className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)] disabled:opacity-40"
          >
            {fetchingGmgn ? "…" : "Retest"}
          </button>
        </div>
        {gmgnCheck?.note && (
          <div className="text-[10px] text-[var(--cryp-mute)] leading-relaxed">{gmgnCheck.note}</div>
        )}
        {gmgnCheck?.openApi && (
          <div className="text-[10px] font-mono-num" style={{ color: gmgnCheck.openApi.ok ? "var(--cryp-gain)" : "var(--cryp-warn)" }}>
            OpenAPI {gmgnCheck.openApi.host} · {gmgnCheck.openApi.configured
              ? (gmgnCheck.openApi.ok ? "OK" : `fail ${gmgnCheck.openApi.error ?? gmgnCheck.openApi.status}`)
              : "no GMGN_API_KEY"}
          </div>
        )}
        {gmgnResults.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {gmgnResults.map(r => (
              <span
                key={r.name}
                className="text-[9px] font-mono-num px-1.5 py-0.5"
                style={{
                  color: r.ok ? "var(--cryp-gain)" : "var(--cryp-loss)",
                  background: r.ok ? "rgba(62,207,142,0.1)" : "rgba(232,93,93,0.1)",
                }}
              >
                {r.name} {r.ok ? "ok" : r.blocked ? "cf" : r.status}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Status pills — idle until summary arrives (avoids false red flash) */}
      <div className="flex flex-wrap gap-2">
        {!summary ? (
          <>
            <Pill tone="idle" label="Helius" sub={pendingSummary ? "Loading…" : summaryError ? "Failed" : "—"} />
            <Pill tone="idle" label="Scan" sub={pendingSummary ? "Loading…" : "—"} />
            <Pill tone="idle" label="Telegram" sub={pendingSummary ? "Loading…" : "—"} />
            <Pill tone="idle" label="Buys" sub="—" />
            <Pill tone="idle" label="Pro" sub="—" />
          </>
        ) : (
          <>
            <Pill
              tone={
                !summary.helius.configured ? "bad"
                  : summary.helius.lastError ? "warn"
                    : "ok"
              }
              label="Helius"
              sub={
                !summary.helius.configured
                  ? "No key"
                  : summary.helius.lastError
                    ? summary.helius.lastError.slice(0, 40)
                    : summary.helius.lastLatencyMs != null
                      ? `${summary.helius.lastLatencyMs}ms`
                      : "OK"
              }
            />
            <Pill
              tone={
                summary.scan.stopped ? "bad"
                  : summary.scan.delayed ? "warn"
                    : summary.scan.running ? "ok"
                      : "idle"
              }
              label={summary.scan.stopped ? "Scan stopped" : summary.scan.delayed ? "Scan delayed" : "Scanning"}
              sub={
                summary.scan.lastScanAt
                  ? `${formatTimeAgo(summary.scan.lastScanAt)} ago · ${summary.scan.lastBuysDetected} buys`
                  : "Waiting…"
              }
            />
            <Pill
              tone={
                summary.telegram.pushEnabled === false ? "idle"
                  : !summary.telegram.configured ? "warn"
                    : summary.telegram.lastError ? "bad"
                      : "ok"
              }
              label={summary.telegram.pushEnabled === false ? "TG stopped" : "Telegram"}
              sub={
                summary.telegram.pushEnabled === false
                  ? (summary.telegram.envMuted ? "Env muted" : "Off in Settings")
                  : !summary.telegram.configured
                    ? "Not saved"
                    : summary.telegram.lastError
                      ? summary.telegram.lastError.slice(0, 36)
                      : summary.telegram.pendingFirstCalls
                        ? `${summary.telegram.pendingFirstCalls} pending`
                        : "Ready"
              }
            />
            <Pill
              tone="ok"
              label="Buys"
              sub={
                summary.buys.lastBuyAt
                  ? `last ${formatTimeAgo(summary.buys.lastBuyAt)} · session ${summary.buys.sessionCount}`
                  : `all-time ${summary.scan.totalBuysAllTime ?? 0}`
              }
            />
            <Pill
              tone="ok"
              label="Pro"
              sub={
                summary.pro.lastQualifyAt
                  ? `qualify ${formatTimeAgo(summary.pro.lastQualifyAt)}`
                  : "waiting"
              }
            />
          </>
        )}
      </div>

      {/* Blockers */}
      {blockers.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-widest text-[#484f58]">
            <AlertTriangle className="w-3 h-3" /> Blockers / warnings
          </div>
          {blockers.map(b => (
            <div
              key={b.code}
              className="px-3 py-2 rounded-lg text-[10px]"
              style={{
                color: levelColor(b.level),
                background: `${levelColor(b.level)}10`,
                border: `1px solid ${levelColor(b.level)}30`,
              }}
            >
              <span className="font-bold uppercase tracking-wider mr-2">{b.code}</span>
              {b.msg}
              {b.code === "pending_first_calls" && (
                <Link href="/?mode=waiting">
                  <span className="ml-2 underline underline-offset-2 cursor-pointer font-semibold">
                    Open Waiting →
                  </span>
                </Link>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Pending first calls — live hold reasons */}
      {(summary?.telegram.pendingFirstCalls ?? 0) > 0 && (
        <WaitingQueuePanel count={summary!.telegram.pendingFirstCalls} />
      )}

      {/* Wallet errors from last scan */}
      {(summary?.scan.walletErrors?.length ?? 0) > 0 && (
        <div className="space-y-1">
          <div className="text-[9px] uppercase tracking-widest text-[#484f58]">Last scan wallet errors</div>
          {summary!.scan.walletErrors.map((w, i) => (
            <div key={i} className="text-[10px] text-[#ef4444]/90 font-mono">
              {w.label || w.address}: {w.error || w.status}
            </div>
          ))}
        </div>
      )}

      {/* Kind filter */}
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
        {kinds.map(k => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className="px-2.5 py-1 rounded-md text-[9px] font-bold uppercase tracking-widest"
            style={
              kind === k
                ? { background: "#f59e0b20", color: "#f59e0b", border: "1px solid #f59e0b40" }
                : { background: "transparent", color: "#484f58", border: "1px solid #21262d" }
            }
          >
            {k === "wallet_buy" ? "buys" : k === "pro_qualify" ? "pro" : k}
          </button>
        ))}
      </div>

      {/* Event list */}
      <div
        className="flex flex-col divide-y rounded-xl overflow-hidden"
        style={{
          border: "1px solid #21262d",
          background: "rgba(13,17,23,0.8)",
          opacity: logPlaceholder && fetchingLog ? 0.72 : 1,
        }}
      >
        {logError && events.length === 0 ? (
          <div className="px-4 py-10 text-center text-[10px] text-[#ef4444] uppercase tracking-widest">
            Log fetch failed — retrying…
          </div>
        ) : pendingLog && events.length === 0 ? (
          <div className="px-4 py-10 text-center text-[10px] text-[#484f58] uppercase tracking-widest">
            Loading events…
          </div>
        ) : events.length === 0 ? (
          <div className="px-4 py-10 text-center text-[10px] text-[#484f58] uppercase tracking-widest">
            No events yet — waits for next scan / alert cycle
          </div>
        ) : (
          events.map(e => (
            <div key={`${e.ts}-${e.id}-${e.msg}`} className="flex items-start gap-3 px-3 py-2">
              <span className="text-[9px] text-[#484f58] tabular-nums shrink-0 w-14 pt-0.5">
                {formatTimeAgo(e.ts) || "now"}
              </span>
              <span
                className="text-[8px] font-black uppercase tracking-wider shrink-0 w-16 pt-0.5"
                style={{ color: levelColor(e.level) }}
              >
                {e.kind}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-[#c9d1d9] leading-snug">{e.msg}</div>
                {e.latencyMs != null && (
                  <div className="text-[8px] text-[#484f58] mt-0.5">{e.latencyMs}ms</div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="flex items-center justify-center gap-3 text-[8px] text-[#30363d] uppercase tracking-widest pt-1">
        <span className="flex items-center gap-1"><Wifi className="w-2.5 h-2.5" /> Helius poll ~2m</span>
        <span className="flex items-center gap-1"><Zap className="w-2.5 h-2.5" /> Pro qualify</span>
        <span className="flex items-center gap-1"><Send className="w-2.5 h-2.5" /> Alerts ~30s</span>
        {summary && !summary.helius.configured && (
          <span className="flex items-center gap-1 text-[#f59e0b]"><WifiOff className="w-2.5 h-2.5" /> No Helius key</span>
        )}
      </div>
    </div>
  );
}
