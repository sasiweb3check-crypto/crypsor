/**
 * Ops — lightweight pipeline visibility (Helius buys, scan delay, Telegram, Pro blockers).
 * Polls /api/ops/summary + /api/ops/log — no heavy DB writes on the hot path.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity, AlertTriangle, Wifi, WifiOff, Send, Zap, RefreshCw,
} from "lucide-react";
import { getApiBase } from "@/lib/api-base";
import { cn, formatTimeAgo } from "@/lib/utils";

const BASE = getApiBase().replace(/\/$/, "");

type OpsLevel = "info" | "warn" | "error";
type OpsKind =
  | "helius" | "wallet_buy" | "scan" | "pro_qualify"
  | "telegram" | "blocker" | "api" | "all";

interface OpsEvent {
  id: number;
  ts: string;
  kind: string;
  level: OpsLevel;
  msg: string;
  meta?: Record<string, unknown>;
  latencyMs?: number;
}

interface OpsSummary {
  ts: string;
  inventory?: {
    tokensTracked: number;
    tokensActive: number;
    buysTotal: number;
    walletsTracked: number;
  };
  helius: {
    configured: boolean;
    lastError: string | null;
    lastOkAt: string | null;
    lastLatencyMs: number | null;
    status?: string;
  };
  scan: {
    running: boolean;
    cycleCount: number;
    lastScanAt: string | null;
    nextScanAt: string | null;
    lastDurationMs: number | null;
    lastBuysDetected: number;
    totalBuysAllTime: number;
    walletsTracked: number;
    scanAgeSec: number | null;
    delayed: boolean;
    stopped: boolean;
    walletErrors: Array<{ label: string; address: string; status: string; error: string | null }>;
  };
  telegram: {
    configured: boolean;
    lastOkAt: string | null;
    lastError: string | null;
    pendingFirstCalls: number;
    pendingMilestones: number;
  };
  pro: {
    lastQualifyAt: string | null;
    insertedTotal: number;
    qualityBelowRecent: number;
  };
  buys: { sessionCount: number; lastBuyAt: string | null };
  blockers: Array<{ code: string; level: OpsLevel; msg: string }>;
}

function levelColor(level: OpsLevel) {
  if (level === "error") return "#ef4444";
  if (level === "warn") return "#f59e0b";
  return "#8b949e";
}

function Pill({
  ok, warn, label, sub,
}: { ok?: boolean; warn?: boolean; label: string; sub?: string }) {
  const color = ok ? "#22c55e" : warn ? "#f59e0b" : "#ef4444";
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

export default function OpsPage() {
  const [kind, setKind] = useState<OpsKind>("all");

  const { data: summary, refetch: refetchSummary, isFetching: fetchingSummary } = useQuery<OpsSummary>({
    queryKey: ["opsSummary"],
    queryFn: () => fetch(`${BASE}/api/ops/summary`).then(r => {
      if (!r.ok) throw new Error(`summary ${r.status}`);
      return r.json();
    }),
    refetchInterval: 12_000,
    staleTime: 8_000,
  });

  const { data: logData, refetch: refetchLog, isFetching: fetchingLog } = useQuery<{ events: OpsEvent[] }>({
    queryKey: ["opsLog", kind],
    queryFn: () =>
      fetch(`${BASE}/api/ops/log?limit=80&kind=${kind}`)
        .then(r => {
          if (!r.ok) throw new Error(`log ${r.status}`);
          return r.json();
        }),
    refetchInterval: 12_000,
    staleTime: 8_000,
  });

  const { data: ping, error: pingError } = useQuery<{ ok: boolean; ts: string }>({
    queryKey: ["opsPing"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/ops/ping`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 20_000,
    staleTime: 15_000,
    retry: 1,
  });

  const events = logData?.events ?? [];
  const blockers = summary?.blockers ?? [];

  const kinds: OpsKind[] = useMemo(
    () => ["all", "helius", "wallet_buy", "scan", "pro_qualify", "telegram", "blocker"],
    [],
  );

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
          { l: "Tokens tracked", v: summary?.inventory?.tokensTracked ?? "—" },
          { l: "Tokens active", v: summary?.inventory?.tokensActive ?? "—" },
          { l: "Wallet buys", v: summary?.inventory?.buysTotal ?? summary?.scan.totalBuysAllTime ?? "—" },
          { l: "Wallets", v: summary?.inventory?.walletsTracked ?? summary?.scan.walletsTracked ?? "—" },
        ].map(x => (
          <div key={x.l}>
            <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">{x.l}</div>
            <div className="font-mono-num text-lg font-bold text-[var(--cryp-mint)] mt-0.5">{x.v}</div>
          </div>
        ))}
      </div>

      {/* API reachability */}
      <div
        className="px-3 py-2 rounded-lg text-[10px]"
        style={{
          background: ping ? "#22c55e12" : "#ef444412",
          border: `1px solid ${ping ? "#22c55e35" : "#ef444435"}`,
          color: ping ? "#22c55e" : "#ef4444",
        }}
      >
        {ping
          ? `API reachable · ${BASE || "(same origin)"} · ping ${formatTimeAgo(ping.ts) || "now"}`
          : `API unreachable — Failed to fetch. Base: ${BASE || "/"} · ${pingError instanceof Error ? pingError.message : "check VITE_API_URL / CORS / cold start"}`}
      </div>

      {/* Status pills */}
      <div className="flex flex-wrap gap-2">
        <Pill
          ok={summary?.helius.configured && !summary.helius.lastError}
          warn={summary?.helius.configured && !!summary.helius.lastError}
          label="Helius"
          sub={
            !summary?.helius.configured
              ? "No key"
              : summary.helius.lastError
                ? summary.helius.lastError.slice(0, 40)
                : summary.helius.lastLatencyMs != null
                  ? `${summary.helius.lastLatencyMs}ms`
                  : "OK"
          }
        />
        <Pill
          ok={summary?.scan.running && !summary.scan.delayed}
          warn={summary?.scan.delayed}
          label={summary?.scan.stopped ? "Scan stopped" : summary?.scan.delayed ? "Scan delayed" : "Scanning"}
          sub={
            summary?.scan.lastScanAt
              ? `${formatTimeAgo(summary.scan.lastScanAt)} ago · ${summary.scan.lastBuysDetected} buys`
              : "Waiting…"
          }
        />
        <Pill
          ok={summary?.telegram.configured && !summary.telegram.lastError}
          warn={summary?.telegram.configured && !!summary.telegram.lastError}
          label="Telegram"
          sub={
            !summary?.telegram.configured
              ? "Not saved"
              : summary.telegram.lastError
                ? summary.telegram.lastError.slice(0, 36)
                : summary.telegram.pendingFirstCalls
                  ? `${summary.telegram.pendingFirstCalls} pending`
                  : "Ready"
          }
        />
        <Pill
          ok
          label="Buys"
          sub={
            summary?.buys.lastBuyAt
              ? `last ${formatTimeAgo(summary.buys.lastBuyAt)} · session ${summary.buys.sessionCount}`
              : `all-time ${summary?.scan.totalBuysAllTime ?? 0}`
          }
        />
        <Pill
          ok={(summary?.pro.insertedTotal ?? 0) >= 0}
          label="Pro"
          sub={
            summary?.pro.lastQualifyAt
              ? `qualify ${formatTimeAgo(summary.pro.lastQualifyAt)}`
              : "waiting"
          }
        />
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
            </div>
          ))}
        </div>
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
        style={{ border: "1px solid #21262d", background: "rgba(13,17,23,0.8)" }}
      >
        {events.length === 0 ? (
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
        {!summary?.helius.configured && (
          <span className="flex items-center gap-1 text-[#f59e0b]"><WifiOff className="w-2.5 h-2.5" /> No Helius key</span>
        )}
      </div>
    </div>
  );
}
