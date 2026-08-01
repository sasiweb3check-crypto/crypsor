/**
 * Best Calls — lightweight desk. Fast tab switches via prefetch + transitions.
 */
import { startTransition, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Copy, ExternalLink, Flame } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  cn, truncateAddress, formatCompactUsd, formatTimeAgo,
  getGmgnUrl, safeSymbol, safeImageUrl,
} from "@/lib/utils";
import {
  CALLS_FEED_KEY, CALLS_STATS_KEY,
  fetchCallsFeed, fetchCallsStats,
  type CallCard, type CallMode, type StatsPeriod,
} from "@/lib/calls-api";
import { OPS_SUMMARY_KEY, fetchOpsSummary } from "@/lib/ops-api";

const MODES: { id: CallMode; label: string }[] = [
  { id: "best", label: "Best" },
  { id: "waiting", label: "Waiting" },
  { id: "hot", label: "Hot" },
  { id: "latest", label: "Latest" },
];

const STATS_PERIODS: { id: StatsPeriod; label: string }[] = [
  { id: "1d", label: "1D" },
  { id: "3d", label: "3D" },
  { id: "7d", label: "7D" },
  { id: "30d", label: "30D" },
];

function feedLimit(mode: CallMode) {
  if (mode === "best") return 8;
  if (mode === "waiting") return 24;
  return 40;
}

function TokenThumb({
  logoUri, address, symbol, fallbackTint,
}: {
  logoUri: string | null;
  address: string;
  symbol: string | null;
  fallbackTint?: string;
}) {
  const [broken, setBroken] = useState(false);
  const sym = safeSymbol(symbol, address) || "?";
  if (broken) {
    return (
      <div
        className="w-10 h-10 rounded-full shrink-0 flex items-center justify-center text-[11px] font-bold"
        style={{
          background: fallbackTint ?? "rgba(61,154,139,0.18)",
          color: "var(--cryp-mint)",
        }}
      >
        {sym.slice(0, 2)}
      </div>
    );
  }
  return (
    <img
      src={safeImageUrl(logoUri, address, symbol)}
      alt=""
      className="w-10 h-10 rounded-full object-cover shrink-0"
      style={{ background: "var(--cryp-elevated)", border: "1px solid var(--cryp-line)" }}
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
    />
  );
}

function WaitingRow({ c }: { c: CallCard }) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const sym = safeSymbol(c.symbol, c.address) || "?";
  const snaps = c.snapCount ?? 0;
  const phase = c.runnerPhase ?? "radar";

  return (
    <article className="call-row">
      <button
        type="button"
        className="flex items-start gap-3 min-w-0 flex-1 text-left"
        onClick={() => setLocation(`/calls/${c.id}`)}
      >
        <TokenThumb
          logoUri={c.logoUri}
          address={c.address}
          symbol={c.symbol}
          fallbackTint="rgba(245,158,11,0.16)"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-display font-bold text-[14px]">${sym}</span>
            <span className="text-[10px] uppercase tracking-wider text-[var(--cryp-warn)]">
              Waiting
            </span>
            <span className="text-[10px] uppercase tracking-wider text-[var(--cryp-mute)]">
              {c.runnerLabel ?? phase}
            </span>
            {c.ctoFlag && (
              <span className="text-[10px] font-bold uppercase text-[var(--cryp-warn)]">CTO</span>
            )}
          </div>
          <div className="text-[11px] text-[var(--cryp-mute)] mt-0.5 truncate">
            {c.calledAt ? `${formatTimeAgo(c.calledAt)} ago` : "—"}
            {" · "}
            {c.holdReason ?? c.blockers?.[0] ?? "Pending ENTRY"}
            {" · "}
            {snaps}/5 snaps
          </div>
          <div className="font-mono-num text-[12px] mt-1 text-[var(--cryp-warn)]">
            Now {(c.nowMultiple ?? 1).toFixed(2)}×
            {" · "}
            {formatCompactUsd(c.calledMcUsd)}
          </div>
        </div>
      </button>

      <div className="flex flex-col items-end gap-1.5 shrink-0">
        <button
          type="button"
          aria-label="Copy address"
          className="text-[var(--cryp-mute)] hover:text-[var(--cryp-mint)] p-1"
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard.writeText(c.address);
            toast({ title: "Copied", description: truncateAddress(c.address) });
          }}
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
        <a
          href={getGmgnUrl(c.chain, c.address)}
          target="_blank"
          rel="noreferrer"
          className="call-action !px-2 !py-1"
          onClick={e => e.stopPropagation()}
          title="Open on GMGN"
        >
          <ExternalLink className="w-3 h-3" />
          GMGN
        </a>
      </div>
    </article>
  );
}

function CallRow({ c }: { c: CallCard }) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const sym = safeSymbol(c.symbol, c.address) || "?";
  const athX = Number.isFinite(c.athMultiple) ? c.athMultiple : 1;
  const nowX = Number.isFinite(c.nowMultiple) ? c.nowMultiple : 1;

  return (
    <article className="call-row">
      <button
        type="button"
        className="flex items-start gap-3 min-w-0 flex-1 text-left"
        onClick={() => setLocation(`/calls/${c.id}`)}
      >
        <TokenThumb logoUri={c.logoUri} address={c.address} symbol={c.symbol} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-display font-bold text-[15px]">${sym}</span>
            {athX >= 2 && (
              <span className="ath-pill">
                {athX >= 10 ? Math.round(athX) : athX.toFixed(1)}x
              </span>
            )}
            {c.ctoFlag === true && (
              <span className="text-[9px] font-bold uppercase tracking-wider text-[var(--cryp-mint)]">
                CTO
              </span>
            )}
            <span className="text-[10px] uppercase tracking-wider text-[var(--cryp-mute)]">
              {c.callLabel}
            </span>
          </div>
          <div className="text-[11px] text-[var(--cryp-mute)] mt-0.5">
            {c.calledAt ? `${formatTimeAgo(c.calledAt)} ago` : "—"}
            {" · "}
            {formatCompactUsd(c.calledMcUsd)} → {formatCompactUsd(c.currentMcUsd)}
            {c.walletBuys > 0 ? ` · ${c.walletBuys}w` : ""}
          </div>
          <div className="font-mono-num text-[12px] mt-1 text-[var(--cryp-warn)]">
            Now {nowX.toFixed(2)}×
            {athX > nowX ? (
              <span className="text-[var(--cryp-gain)]"> · Peak {athX.toFixed(1)}×</span>
            ) : null}
          </div>
        </div>
      </button>

      <div className="flex flex-col items-end gap-1.5 shrink-0">
        <button
          type="button"
          aria-label="Copy address"
          className="text-[var(--cryp-mute)] hover:text-[var(--cryp-mint)] p-1"
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard.writeText(c.address);
            toast({ title: "Copied", description: truncateAddress(c.address) });
          }}
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
        <a
          href={getGmgnUrl(c.chain, c.address)}
          target="_blank"
          rel="noreferrer"
          className="call-action !px-2 !py-1"
          onClick={e => e.stopPropagation()}
          title="Open on GMGN"
        >
          <ExternalLink className="w-3 h-3" />
          GMGN
        </a>
      </div>
    </article>
  );
}

export default function CallsPage() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<CallMode>(() => {
    if (typeof window === "undefined") return "best";
    const q = new URLSearchParams(window.location.search).get("mode");
    return q === "waiting" || q === "hot" || q === "latest" || q === "best" ? q : "best";
  });
  const [period, setPeriod] = useState<StatsPeriod>("7d");

  // Prefetch every tab so switches feel instant
  useEffect(() => {
    for (const m of MODES) {
      void qc.prefetchQuery({
        queryKey: CALLS_FEED_KEY(m.id),
        queryFn: () => fetchCallsFeed(m.id, feedLimit(m.id)),
        staleTime: 8_000,
      });
    }
  }, [qc]);

  const { data: stats } = useQuery({
    queryKey: CALLS_STATS_KEY(period),
    queryFn: () => fetchCallsStats(period),
    refetchInterval: 30_000,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });

  const { data: opsSummary } = useQuery({
    queryKey: OPS_SUMMARY_KEY,
    queryFn: fetchOpsSummary,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const {
    data, isLoading, isFetching, isError, error, refetch,
  } = useQuery({
    queryKey: CALLS_FEED_KEY(mode),
    queryFn: () => fetchCallsFeed(mode, feedLimit(mode)),
    refetchInterval: 15_000,
    staleTime: 8_000,
    placeholderData: keepPreviousData,
    retry: 3,
  });

  const cards = data?.cards ?? [];
  const pendingN = data?.pendingFirstCalls
    ?? opsSummary?.telegram?.pendingFirstCalls
    ?? 0;

  const switchMode = (next: CallMode) => {
    if (next === mode) return;
    startTransition(() => setMode(next));
    const url = new URL(window.location.href);
    if (next === "best") url.searchParams.delete("mode");
    else url.searchParams.set("mode", next);
    window.history.replaceState({}, "", url.pathname + url.search);
  };

  const prefetchMode = (m: CallMode) => {
    void qc.prefetchQuery({
      queryKey: CALLS_FEED_KEY(m),
      queryFn: () => fetchCallsFeed(m, feedLimit(m)),
      staleTime: 8_000,
    });
  };

  const statsLine = useMemo(() => {
    if (!stats) return null;
    return [
      `${stats.winRate}% WR`,
      stats.bestX ? `${stats.bestX.toFixed(1)}x` : null,
      `${stats.signals} ENTRY`,
      stats.avgX ? `${stats.avgX.toFixed(1)}x avg` : null,
    ].filter(Boolean).join(" · ");
  }, [stats]);

  return (
    <div className="px-4 pt-3 pb-10 space-y-3">
      {/* Tabs first — primary interaction */}
      <div
        className="call-tabs"
        role="tablist"
        aria-label="Call modes"
      >
        {MODES.map(m => {
          const active = mode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={active}
              onMouseEnter={() => prefetchMode(m.id)}
              onFocus={() => prefetchMode(m.id)}
              onClick={() => switchMode(m.id)}
              className={cn("call-tab", active && "call-tab-active")}
            >
              {m.label}
              {m.id === "waiting" && pendingN > 0 && (
                <span className="font-mono-num ml-1 opacity-80">{pendingN}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-2 min-h-[22px]">
        <p className="text-[11px] text-[var(--cryp-mute)] truncate font-mono-num">
          {mode === "waiting"
            ? `${pendingN || cards.length || 0} pending · latest called · not in WR`
            : (statsLine ?? (isFetching ? "sync…" : "—"))}
        </p>
        <label className="relative inline-flex items-center shrink-0">
          <span className="sr-only">Stats period</span>
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as StatsPeriod)}
            className="appearance-none pl-2 pr-6 py-1 rounded text-[10px] font-bold uppercase tracking-wider"
            style={{
              color: "var(--cryp-mute)",
              background: "transparent",
              border: "1px solid var(--cryp-line)",
            }}
            aria-label="Stats period"
          >
            {STATS_PERIODS.map(p => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="space-y-1.5">
        {isError && cards.length === 0 && (
          <div className="call-row flex-col items-center py-8 gap-2 text-center">
            <div className="text-[13px] text-[var(--cryp-loss)]">Couldn’t load calls</div>
            <div className="text-[11px] text-[var(--cryp-mute)]">
              {error instanceof Error ? error.message : "API waking up"}
            </div>
            <button type="button" onClick={() => void refetch()} className="call-action">
              Retry
            </button>
          </div>
        )}
        {isLoading && cards.length === 0 && !isError && (
          <>
            {[0, 1, 2].map(i => (
              <div key={i} className="call-row shimmer-card h-16" />
            ))}
          </>
        )}
        {!isLoading && !isError && cards.length === 0 && (
          <div className="call-row justify-center py-10 text-[11px] text-[var(--cryp-mute)] uppercase tracking-widest">
            {mode === "waiting" ? "Queue clear" : "Scanning…"}
          </div>
        )}
        {cards.map(c => (
          mode === "waiting"
            ? <WaitingRow key={c.id} c={c} />
            : <CallRow key={c.id} c={c} />
        ))}
      </div>

      {(mode === "best" || mode === "hot" || mode === "latest") && cards.length > 0 && (
        <p className="text-[10px] text-[var(--cryp-mute)] text-center pt-1">
          <Flame className="w-3 h-3 inline-block mr-1 align-[-2px]" />
          ENTRY-served only · Waiting stays in Waiting
        </p>
      )}
    </div>
  );
}
