/**
 * Token desk v2 — pump-fullend scoring / filters / labels.
 * Data source: tracked-wallet buys only. No Crypsor call-quality / GMGN rank.
 */
import { startTransition, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import {
  cn, formatCompactUsd,
  getGmgnUrl, safeSymbol, safeImageUrl,
} from "@/lib/utils";
import {
  CALLS_FEED_KEY, FILTER_BLURB, PAGE_SIZE,
  PUMP_FILTER_PRESETS, PUMP_SORT_OPTIONS,
  fetchCallsFeed,
  type CallCard, type PumpFilterId, type PumpSortId,
} from "@/lib/calls-api";
import { useLiveSse } from "@/hooks/use-live-tokens";

function TokenThumb({
  logoUri, address, symbol,
}: {
  logoUri: string | null;
  address: string;
  symbol: string | null;
}) {
  const [broken, setBroken] = useState(false);
  const sym = safeSymbol(symbol, address) || "?";
  if (broken) {
    return <div className="tok-thumb tok-thumb-fallback">{sym.slice(0, 2)}</div>;
  }
  return (
    <img
      src={safeImageUrl(logoUri, address, symbol)}
      alt=""
      className="tok-thumb"
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
    />
  );
}

function fmtPct(v: number | null | undefined, digits = 0) {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

function gainClass(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "text-[var(--cryp-mute)]";
  if (v > 0) return "text-[var(--cryp-gain)]";
  if (v < 0) return "text-[var(--cryp-loss)]";
  return "text-[var(--cryp-mute)]";
}

function TableRow({ c }: { c: CallCard }) {
  const [, setLocation] = useLocation();
  const sym = safeSymbol(c.symbol, c.address) || "?";
  const gmgn = getGmgnUrl(c.chain, c.address);
  const gain = c.pumpGainSinceDetection ?? c.gainPct;
  const grade = c.pumpGrade;

  return (
    <tr
      className={cn(
        "tok-row",
        grade === "S" && "tok-row-grade-s",
        grade === "A" && "tok-row-grade-a",
        c.pumpBuySignal === "STRONG_BUY" && "tok-row-buy",
      )}
      onClick={() => setLocation(`/calls/${c.id}`)}
    >
      <td className="tok-td tok-td-token">
        <div className="flex items-center gap-1.5 min-w-0">
          <TokenThumb logoUri={c.logoUri} address={c.address} symbol={c.symbol} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1 min-w-0 flex-wrap">
              <span className="font-display font-bold text-[12px] truncate">${sym}</span>
              {grade && (
                <span className={cn("tok-chip tok-chip-grade", `tok-chip-grade-${grade.toLowerCase()}`)}>
                  {grade} {c.pumpScore ?? ""}
                </span>
              )}
              {c.pumpBuySignal === "STRONG_BUY" && (
                <span className="tok-chip tok-chip-buy">BUY</span>
              )}
              {c.pumpBuySignal === "WATCH" && (
                <span className="tok-chip tok-chip-pwatch">WATCH</span>
              )}
              {c.pumpIntraSignal === "INTRA_NOW" && (
                <span className="tok-chip tok-chip-intra">INTRA</span>
              )}
              {c.pumpIntraSignal === "INTRA_SOON" && (
                <span className="tok-chip tok-chip-intra">SOON</span>
              )}
            </div>
            <div className="text-[9px] text-[var(--cryp-mute)] truncate">
              {c.pumpRecommendation || "—"}
              {c.walletBuys > 0 && <span className="ml-1">· {c.walletBuys} buys</span>}
              {c.pumpTags?.[0] && <span className="ml-1 opacity-80">· {c.pumpTags[0].label}</span>}
              {c.pumpTags?.[1] && <span className="ml-1 opacity-70">· {c.pumpTags[1].label}</span>}
            </div>
          </div>
        </div>
      </td>
      <td className="tok-td tok-td-num font-mono-num">
        {formatCompactUsd(c.currentMcUsd ?? c.pumpMarketCap)}
      </td>
      <td className={cn("tok-td tok-td-num font-mono-num", gainClass(gain))}>
        <span className="tok-gain-main">{fmtPct(gain, 0)}</span>
        <span className="tok-gain-sub">since detect</span>
      </td>
      <td className={cn("tok-td tok-td-num font-mono-num", gainClass(c.pumpAthGain))}>
        <span className="tok-gain-main">{fmtPct(c.pumpAthGain, 0)}</span>
        <span className="tok-gain-sub">ATH</span>
      </td>
      <td className="tok-td tok-td-num font-mono-num text-[var(--cryp-mute)]">
        {formatCompactUsd(c.pumpVolume24h ?? c.volume24hUsd)}
      </td>
      <td className="tok-td tok-td-link">
        <a
          href={gmgn}
          target="_blank"
          rel="noreferrer"
          className="tok-gmgn"
          title="Open chart"
          aria-label={`Open ${sym}`}
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </td>
    </tr>
  );
}

function readFilterFromUrl(): PumpFilterId {
  if (typeof window === "undefined") return "all";
  const q = new URLSearchParams(window.location.search).get("filter")
    ?? new URLSearchParams(window.location.search).get("mode");
  const ids = PUMP_FILTER_PRESETS.map((p) => p.id);
  return ids.includes(q as PumpFilterId) ? (q as PumpFilterId) : "all";
}

export default function CallsPage() {
  const qc = useQueryClient();
  const { connected } = useLiveSse();
  const [filter, setFilter] = useState<PumpFilterId>(readFilterFromUrl);
  const [sort, setSort] = useState<PumpSortId>("score");
  const [minScore, setMinScore] = useState(0);
  const [page, setPage] = useState(1);

  const feedPollMs = connected ? 60_000 : 15_000;

  const {
    data, isLoading, isFetching, isError, error, refetch,
  } = useQuery({
    queryKey: CALLS_FEED_KEY(filter, sort, page, minScore),
    queryFn: () => fetchCallsFeed(filter, page, PAGE_SIZE, sort, minScore),
    refetchInterval: feedPollMs,
    staleTime: connected ? 6_000 : 2_000,
    placeholderData: (prev) => (prev && prev.filter === filter ? prev : undefined),
    retry: 3,
  });

  const cards = data?.cards ?? [];
  const total = data?.total ?? 0;
  const pages = data?.pages ?? 1;
  const showLoading = isLoading && cards.length === 0;

  const saCount = useMemo(
    () => cards.filter((c) => c.pumpGrade === "S" || c.pumpGrade === "A").length,
    [cards],
  );

  const switchFilter = (next: PumpFilterId) => {
    if (next === filter) return;
    startTransition(() => {
      setFilter(next);
      setPage(1);
    });
    const url = new URL(window.location.href);
    if (next === "all") url.searchParams.delete("filter");
    else url.searchParams.set("filter", next);
    url.searchParams.delete("mode");
    window.history.replaceState({}, "", url.pathname + url.search);
  };

  const prefetchFilter = (f: PumpFilterId) => {
    void qc.prefetchQuery({
      queryKey: CALLS_FEED_KEY(f, sort, 1, minScore),
      queryFn: () => fetchCallsFeed(f, 1, PAGE_SIZE, sort, minScore),
      staleTime: 8_000,
    });
  };

  return (
    <div className="px-2 sm:px-3 pt-2.5 pb-8 space-y-2 w-full max-w-full overflow-x-hidden">
      <div className="pump-filter-bar" role="tablist" aria-label="Pump filters">
        {PUMP_FILTER_PRESETS.map((p) => {
          const active = filter === p.id;
          return (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={active}
              onMouseEnter={() => prefetchFilter(p.id)}
              onFocus={() => prefetchFilter(p.id)}
              onClick={() => switchFilter(p.id)}
              className={cn(
                "pump-filter-chip",
                active && "pump-filter-chip-on",
                active && p.id === "buy" && "pump-filter-buy",
                active && p.id === "watch" && "pump-filter-watch",
                active && p.id === "intra" && "pump-filter-intra",
                active && p.id === "top" && "pump-filter-top",
              )}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-2 min-h-[18px] flex-wrap">
        <p className="text-[10px] text-[var(--cryp-mute)] truncate">
          <span className="font-mono-num">
            {total} tokens
            {saCount > 0 && ` · ${saCount} S/A on page`}
          </span>
          <span className="mx-1 opacity-40">·</span>
          <span>{FILTER_BLURB[filter]}</span>
          {connected && <span className="text-[var(--cryp-gain)] ml-1">· Live</span>}
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <label className="flex items-center gap-1.5 text-[10px] text-[var(--cryp-mute)]">
            <span className="uppercase tracking-wider">Sort</span>
            <select
              value={sort}
              onChange={(e) => startTransition(() => {
                setSort(e.target.value as PumpSortId);
                setPage(1);
              })}
              className="tok-filter-select !w-auto !min-w-0 pl-2 pr-5"
              aria-label="Sort"
            >
              {PUMP_SORT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] text-[var(--cryp-mute)]">
            <span className="uppercase tracking-wider">Min</span>
            <input
              type="range"
              min={0}
              max={90}
              step={5}
              value={minScore}
              onChange={(e) => startTransition(() => {
                setMinScore(Number(e.target.value));
                setPage(1);
              })}
              className="w-16 accent-[var(--cryp-mint)]"
              aria-label="Minimum pump score"
            />
            <span className="font-mono-num text-[var(--cryp-mint)] w-5">{minScore}</span>
          </label>
        </div>
      </div>

      <div className="tok-table-wrap">
        <table className="tok-table">
          <thead>
            <tr>
              <th className="tok-th tok-th-token">Token</th>
              <th className="tok-th tok-th-num">MC</th>
              <th className="tok-th tok-th-num">Gain</th>
              <th className="tok-th tok-th-num">ATH</th>
              <th className="tok-th tok-th-num">Vol 24H</th>
              <th className="tok-th tok-th-link">Chart</th>
            </tr>
          </thead>
          <tbody key={`${filter}-${sort}-${minScore}`} className="fade-up">
            {isError && (
              <tr>
                <td colSpan={6} className="tok-empty">
                  <div className="text-[13px] text-[var(--cryp-loss)]">Couldn’t load</div>
                  <div className="text-[11px] text-[var(--cryp-mute)] mt-1">
                    {error instanceof Error ? error.message : "API waking up"}
                  </div>
                  <button type="button" onClick={() => void refetch()} className="call-action mt-2">
                    Retry
                  </button>
                </td>
              </tr>
            )}
            {!isError && showLoading && (
              [0, 1, 2, 3, 4].map((i) => (
                <tr key={i} className="tok-row">
                  <td colSpan={6} className="tok-td">
                    <div className="shimmer h-8 rounded-md" />
                  </td>
                </tr>
              ))
            )}
            {!isError && !showLoading && cards.length === 0 && (
              <tr>
                <td colSpan={6} className="tok-empty text-[11px] text-[var(--cryp-mute)] uppercase tracking-widest">
                  {isFetching ? "Scanning…" : "No matches · waiting for buys"}
                </td>
              </tr>
            )}
            {!isError && cards.map((c) => (
              <TableRow key={c.id} c={c} />
            ))}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="tok-pager">
          <button
            type="button"
            className="tok-pager-btn"
            disabled={page <= 1 || isFetching}
            onClick={() => startTransition(() => setPage((p) => Math.max(1, p - 1)))}
            aria-label="Previous page"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="font-mono-num text-[11px] text-[var(--cryp-mute)]">
            {page} / {pages}
            <span className="opacity-60"> · {total}</span>
          </span>
          <button
            type="button"
            className="tok-pager-btn"
            disabled={page >= pages || isFetching}
            onClick={() => startTransition(() => setPage((p) => Math.min(pages, p + 1)))}
            aria-label="Next page"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
