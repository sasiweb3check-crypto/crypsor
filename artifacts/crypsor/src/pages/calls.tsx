/**
 * Token desk — live Waiting / Best / Hot / Latest.
 * SSE patches MC; client re-sorts Hot heat live; clickable column sorts.
 */
import { startTransition, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ArrowDown, ArrowUp, ArrowUpDown,
  ChevronLeft, ChevronRight, ExternalLink, SlidersHorizontal,
} from "lucide-react";
import {
  cn, formatCompactUsd, formatTimeAgo,
  getGmgnUrl, safeSymbol, safeImageUrl,
} from "@/lib/utils";
import {
  CALLS_FEED_KEY, CALLS_STATS_KEY, MODE_BLURB, PAGE_SIZE,
  fetchCallsFeed, fetchCallsStats, heatScore, sortDeskCards,
  type CallCard, type CallMode, type DeskSortDir, type DeskSortKey,
  type FeedFilters, type StatsPeriod,
} from "@/lib/calls-api";
import { OPS_SUMMARY_KEY, fetchOpsSummary } from "@/lib/ops-api";
import { useLiveSse } from "@/hooks/use-live-tokens";

const MODES: { id: CallMode; label: string }[] = [
  { id: "waiting", label: "Waiting" },
  { id: "best", label: "Best" },
  { id: "hot", label: "Hot" },
  { id: "latest", label: "Latest" },
];

const STATS_PERIODS: { id: StatsPeriod; label: string }[] = [
  { id: "1d", label: "1D" },
  { id: "3d", label: "3D" },
  { id: "7d", label: "7D" },
  { id: "30d", label: "30D" },
];

const LABEL_OPTS = [
  { id: "all", label: "All labels" },
  { id: "elite", label: "Elite" },
  { id: "strong", label: "Strong" },
  { id: "watch", label: "Watch" },
  { id: "noise", label: "Noise" },
];

const QUALITY_OPTS = [
  { id: "all", label: "All scores" },
  { id: "very_good", label: "Very good" },
  { id: "good", label: "Good" },
  { id: "below", label: "Below" },
];

const emptyFilters: FeedFilters = {};

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

function fmtX(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)}×`;
}

function gainClass(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "text-[var(--cryp-mute)]";
  if (v > 0) return "text-[var(--cryp-gain)]";
  if (v < 0) return "text-[var(--cryp-loss)]";
  return "text-[var(--cryp-mute)]";
}

function SortHead({
  label, col, active, dir, onSort, align = "right",
}: {
  label: string;
  col: DeskSortKey;
  active: DeskSortKey;
  dir: DeskSortDir;
  onSort: (k: DeskSortKey) => void;
  align?: "left" | "right" | "center";
}) {
  const show = active === col;
  return (
    <th
      className={cn(
        "tok-th",
        align === "right" && "tok-th-num",
        align === "center" && "tok-th-link",
        align === "left" && "tok-th-token",
        col === "buys" && "tok-th-buys",
      )}
      aria-sort={show ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        className={cn("tok-sort-btn", show && "tok-sort-btn-on")}
        onClick={() => onSort(col)}
        aria-label={`Sort by ${label}`}
      >
        <span>{label}</span>
        {show ? (
          dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
        ) : (
          <ArrowUpDown className="w-3 h-3 opacity-40" />
        )}
      </button>
    </th>
  );
}

function TableRow({
  c, waiting, hot,
}: {
  c: CallCard;
  waiting: boolean;
  hot: boolean;
}) {
  const [, setLocation] = useLocation();
  const sym = safeSymbol(c.symbol, c.address) || "?";
  const currentGainPct = c.gainPct != null && Number.isFinite(c.gainPct)
    ? c.gainPct
    : (c.nowMultiple > 0 ? (c.nowMultiple - 1) * 100 : null);
  const athGainPct = c.athMultiple > 0 ? (c.athMultiple - 1) * 100 : null;
  const gmgn = getGmgnUrl(c.chain, c.address);
  const heat = hot ? heatScore(c) : 0;

  return (
    <tr
      className={cn("tok-row", hot && heat > 40 && "tok-row-hot")}
      onClick={() => setLocation(`/calls/${c.id}`)}
    >
      <td className="tok-td tok-td-token">
        <div className="flex items-center gap-1.5 min-w-0">
          <TokenThumb logoUri={c.logoUri} address={c.address} symbol={c.symbol} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1 min-w-0">
              <span className="font-display font-bold text-[12px] truncate">${sym}</span>
              {waiting ? (
                <span className="tok-chip tok-chip-wait">
                  {c.runnerPhase || "Wait"}
                </span>
              ) : c.callLabel ? (
                <span className={cn(
                  "tok-chip hidden sm:inline",
                  c.callLabel === "elite" && "tok-chip-elite",
                  c.callLabel === "strong" && "tok-chip-strong",
                )}>
                  {c.callLabel}
                </span>
              ) : null}
              {hot && heat > 50 && (
                <span className="tok-chip tok-chip-hot">Hot</span>
              )}
            </div>
            <div className="text-[9px] text-[var(--cryp-mute)] truncate">
              {waiting ? (
                <>
                  {c.snapCount != null && (
                    <span className="mr-1">snaps {c.snapCount}/{Math.max(5, (c.snapCount ?? 0) + (c.snapsNeeded ?? 0))}</span>
                  )}
                  <span className="text-[var(--cryp-warn)]">
                    {c.holdReason || c.blockers?.[0] || (c.calledAt ? formatTimeAgo(c.calledAt) : "—")}
                  </span>
                </>
              ) : (
                <>
                  {c.calledAt ? formatTimeAgo(c.calledAt) : "—"}
                  {c.callScore > 0 && (
                    <span className="ml-1 text-[var(--cryp-mint)]">sc {c.callScore}</span>
                  )}
                  {c.gain1hPct != null && (
                    <span className={cn("ml-1", gainClass(c.gain1hPct))}>
                      1H {fmtPct(c.gain1hPct, 0)}
                    </span>
                  )}
                  {hot && c.momentum1h > 0 && (
                    <span className="ml-1 text-[var(--cryp-mint)]">mom {c.momentum1h}</span>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </td>
      <td className="tok-td tok-td-num font-mono-num">
        {formatCompactUsd(c.currentMcUsd)}
      </td>
      <td className={cn(
        "tok-td tok-td-num font-mono-num",
        hot ? (heat > 40 ? "text-[var(--cryp-warn)]" : "text-[var(--cryp-ink)]") : gainClass(currentGainPct),
      )}>
        {hot ? (
          <>
            <span className="tok-gain-main">{Math.round(heat)}</span>
            <span className="tok-gain-sub">{fmtPct(c.gain1hPct, 0)} 1H</span>
          </>
        ) : (
          <>
            <span className="tok-gain-main">{fmtPct(currentGainPct, 0)}</span>
            <span className="tok-gain-sub">{fmtX(c.nowMultiple)}</span>
          </>
        )}
      </td>
      <td className={cn("tok-td tok-td-num font-mono-num", gainClass(athGainPct))}>
        <span className="tok-gain-main">{fmtPct(athGainPct, 0)}</span>
        <span className="tok-gain-sub">{fmtX(c.athMultiple)}</span>
      </td>
      <td className={cn(
        "tok-td tok-td-num font-mono-num",
        c.walletBuys > 0 ? "text-[var(--cryp-mint)]" : "text-[var(--cryp-mute)]",
      )}>
        {c.walletBuys > 0 ? c.walletBuys : "—"}
      </td>
      <td className="tok-td tok-td-link">
        <a
          href={gmgn}
          target="_blank"
          rel="noreferrer"
          className="tok-gmgn"
          title="Open on GMGN"
          aria-label={`Open ${sym} on GMGN`}
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="w-3.5 h-3.5" />
          <span className="tok-gmgn-label">GMGN</span>
        </a>
      </td>
    </tr>
  );
}

function FilterSelect({
  value, onChange, options, ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { id: string; label: string }[];
  ariaLabel: string;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      aria-label={ariaLabel}
      className="tok-filter-select"
    >
      {options.map(o => (
        <option key={o.id} value={o.id}>{o.label}</option>
      ))}
    </select>
  );
}

function NumFilter({
  value, onChange, placeholder, ariaLabel,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  return (
    <input
      type="number"
      inputMode="numeric"
      placeholder={placeholder}
      aria-label={ariaLabel}
      value={value ?? ""}
      onChange={e => {
        const raw = e.target.value;
        if (raw === "") onChange(undefined);
        else {
          const n = Number(raw);
          onChange(Number.isFinite(n) ? n : undefined);
        }
      }}
      className="tok-filter-input"
    />
  );
}

function readModeFromUrl(): CallMode {
  if (typeof window === "undefined") return "waiting";
  const q = new URLSearchParams(window.location.search).get("mode");
  return q === "waiting" || q === "hot" || q === "latest" || q === "best" ? q : "waiting";
}

export default function CallsPage() {
  const qc = useQueryClient();
  const { connected } = useLiveSse();
  const [mode, setMode] = useState<CallMode>(readModeFromUrl);
  const [page, setPage] = useState(1);
  const [period, setPeriod] = useState<StatsPeriod>("7d");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filters, setFilters] = useState<FeedFilters>(emptyFilters);
  const [sortKey, setSortKey] = useState<DeskSortKey>("default");
  const [sortDir, setSortDir] = useState<DeskSortDir>("desc");

  useEffect(() => {
    const sync = () => {
      const next = readModeFromUrl();
      setMode((prev) => {
        if (prev === next) return prev;
        setPage(1);
        setSortKey("default");
        setSortDir("desc");
        return next;
      });
    };
    window.addEventListener("popstate", sync);
    const id = window.setInterval(sync, 800);
    return () => {
      window.removeEventListener("popstate", sync);
      window.clearInterval(id);
    };
  }, []);

  // Hot needs fresher poll so heat stays honest if SSE drops
  const feedPollMs = connected
    ? (mode === "hot" ? 45_000 : mode === "waiting" ? 60_000 : 90_000)
    : (mode === "waiting" || mode === "hot" ? 10_000 : 18_000);

  const {
    data, isLoading, isFetching, isError, error, refetch, isPlaceholderData,
  } = useQuery({
    queryKey: CALLS_FEED_KEY(mode, page, filters),
    queryFn: () => fetchCallsFeed(mode, page, PAGE_SIZE, filters),
    refetchInterval: feedPollMs,
    staleTime: connected ? (mode === "hot" ? 4_000 : 8_000) : 2_000,
    // Only keep previous data when it's the SAME mode (avoids blank flash on warm cache)
    placeholderData: (prev) => (prev && prev.mode === mode ? prev : undefined),
    retry: 3,
  });

  const modeMismatch = data != null && data.mode !== mode;
  const rawCards = (!modeMismatch && data?.cards) ? data.cards : [];
  const cards = useMemo(
    () => sortDeskCards(rawCards, mode, sortKey, sortDir),
    [rawCards, mode, sortKey, sortDir],
  );
  const total = (!modeMismatch && data) ? data.total : 0;
  const pages = (!modeMismatch && data) ? data.pages : 1;
  const showLoading = (isLoading || (isPlaceholderData && modeMismatch) || modeMismatch)
    && cards.length === 0;

  const { data: stats } = useQuery({
    queryKey: CALLS_STATS_KEY(period),
    queryFn: () => fetchCallsStats(period),
    refetchInterval: connected ? 90_000 : 30_000,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });

  const { data: opsSummary } = useQuery({
    queryKey: OPS_SUMMARY_KEY,
    queryFn: fetchOpsSummary,
    refetchInterval: connected ? 90_000 : 25_000,
    staleTime: 15_000,
  });

  const pendingN = data?.pendingFirstCalls
    ?? opsSummary?.telegram?.pendingFirstCalls
    ?? 0;

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (filters.label && filters.label !== "all") n++;
    if (filters.quality && filters.quality !== "all") n++;
    if (filters.minScore != null) n++;
    if (filters.minVol1h != null) n++;
    if (filters.minGain1h != null) n++;
    if (filters.minMom1h != null) n++;
    if (filters.minMom6h != null) n++;
    return n;
  }, [filters]);

  const effectiveSort: DeskSortKey = sortKey === "default"
    ? (mode === "hot" ? "heat" : mode === "best" ? "score" : "called")
    : sortKey;

  const switchMode = (next: CallMode) => {
    if (next === mode) return;
    startTransition(() => {
      setMode(next);
      setPage(1);
      setSortKey("default");
      setSortDir("desc");
    });
    const url = new URL(window.location.href);
    if (next === "waiting") url.searchParams.delete("mode");
    else url.searchParams.set("mode", next);
    window.history.replaceState({}, "", url.pathname + url.search);
  };

  const prefetchMode = (m: CallMode) => {
    void qc.prefetchQuery({
      queryKey: CALLS_FEED_KEY(m, 1, filters),
      queryFn: () => fetchCallsFeed(m, 1, PAGE_SIZE, filters),
      staleTime: 8_000,
    });
  };

  const toggleSort = (col: DeskSortKey) => {
    startTransition(() => {
      if (effectiveSort === col) {
        setSortKey(col);
        setSortDir((d) => (d === "desc" ? "asc" : "desc"));
      } else {
        setSortKey(col);
        setSortDir("desc");
      }
    });
  };

  const patchFilter = <K extends keyof FeedFilters>(key: K, value: FeedFilters[K]) => {
    startTransition(() => {
      setPage(1);
      setFilters(prev => {
        const next = { ...prev, [key]: value };
        if (value === undefined || value === "all" || value === "") delete next[key];
        return next;
      });
    });
  };

  const statsLine = useMemo(() => {
    if (!stats) return null;
    return [
      `${stats.winRate}% WR`,
      stats.bestX ? `${stats.bestX.toFixed(1)}x` : null,
      `${stats.signals} ENTRY`,
    ].filter(Boolean).join(" · ");
  }, [stats]);

  return (
    <div className="px-2 sm:px-3 pt-2.5 pb-8 space-y-2 w-full max-w-full overflow-x-hidden">
      <div className={cn("call-tabs", `call-tabs-${mode}`)} role="tablist" aria-label="Call modes">
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
              className={cn("call-tab", active && "call-tab-active", active && `call-tab-${m.id}`)}
            >
              {m.label}
              {m.id === "waiting" && pendingN > 0 && (
                <span className="font-mono-num ml-1 opacity-80">{pendingN}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-2 min-h-[18px]">
        <p className="text-[10px] text-[var(--cryp-mute)] truncate">
          <span className="font-mono-num">
            {mode === "waiting"
              ? `${pendingN || total || 0} pending`
              : (statsLine ?? (isFetching ? "sync…" : "—"))}
            {total > 0 && ` · ${total}`}
          </span>
          <span className="mx-1 opacity-40">·</span>
          <span>{MODE_BLURB[mode]}</span>
          {connected && <span className="text-[var(--cryp-gain)] ml-1">· Live</span>}
          {sortKey !== "default" && (
            <button
              type="button"
              className="ml-1.5 text-[var(--cryp-mint)] underline-offset-2 hover:underline"
              onClick={() => startTransition(() => { setSortKey("default"); setSortDir("desc"); })}
            >
              reset sort
            </button>
          )}
        </p>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setFiltersOpen(v => !v)}
            className={cn(
              "tok-filter-toggle",
              (filtersOpen || activeFilterCount > 0) && "tok-filter-toggle-on",
            )}
            aria-expanded={filtersOpen}
            aria-label="Toggle filters"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            {activeFilterCount > 0 && (
              <span className="font-mono-num">{activeFilterCount}</span>
            )}
          </button>
          <label className="relative inline-flex items-center">
            <span className="sr-only">Stats period</span>
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value as StatsPeriod)}
              className="tok-filter-select !w-auto !min-w-0 pl-2 pr-5"
              aria-label="Stats period"
            >
              {STATS_PERIODS.map(p => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {filtersOpen && (
        <div className="tok-filters fade-up">
          <div className="tok-filters-section">
            <div className="tok-filters-label">Score · Label</div>
            <div className="tok-filters-row">
              <FilterSelect
                value={filters.label ?? "all"}
                onChange={v => patchFilter("label", v === "all" ? undefined : v)}
                options={LABEL_OPTS}
                ariaLabel="Call label"
              />
              <FilterSelect
                value={filters.quality ?? "all"}
                onChange={v => patchFilter("quality", v === "all" ? undefined : v)}
                options={QUALITY_OPTS}
                ariaLabel="Quality score"
              />
              <NumFilter
                value={filters.minScore}
                onChange={v => patchFilter("minScore", v)}
                placeholder="Min score"
                ariaLabel="Minimum call score"
              />
            </div>
          </div>
          <div className="tok-filters-section">
            <div className="tok-filters-label">1H gain % · Vol score · Mom</div>
            <div className="tok-filters-row">
              <NumFilter
                value={filters.minGain1h}
                onChange={v => patchFilter("minGain1h", v)}
                placeholder="Min 1H %"
                ariaLabel="Minimum 1H percent market-cap gain"
              />
              <NumFilter
                value={filters.minVol1h}
                onChange={v => patchFilter("minVol1h", v)}
                placeholder="Min vol 0-100"
                ariaLabel="Minimum volume intensity score from 0 to 100"
              />
              <NumFilter
                value={filters.minMom1h}
                onChange={v => patchFilter("minMom1h", v)}
                placeholder="Min mom buys"
                ariaLabel="Minimum 1H momentum buy count"
              />
            </div>
          </div>
          <div className="tok-filters-section">
            <div className="tok-filters-label">6H momentum</div>
            <div className="tok-filters-row">
              <NumFilter
                value={filters.minMom6h}
                onChange={v => patchFilter("minMom6h", v)}
                placeholder="Min mom 6H"
                ariaLabel="Minimum 6H momentum buys"
              />
              {activeFilterCount > 0 && (
                <button
                  type="button"
                  className="tok-filter-clear"
                  onClick={() => startTransition(() => setFilters(emptyFilters))}
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="tok-table-wrap">
        <table className="tok-table">
          <thead>
            <tr>
              <SortHead
                label="Token"
                col={mode === "best" ? "score" : "called"}
                active={effectiveSort}
                dir={sortDir}
                onSort={toggleSort}
                align="left"
              />
              <SortHead label="MC" col="mc" active={effectiveSort} dir={sortDir} onSort={toggleSort} />
              <SortHead
                label={mode === "hot" ? "Heat" : "Entry"}
                col={mode === "hot" ? "heat" : "entry"}
                active={effectiveSort}
                dir={sortDir}
                onSort={toggleSort}
              />
              <SortHead label="ATH" col="ath" active={effectiveSort} dir={sortDir} onSort={toggleSort} />
              <SortHead label="Buys" col="buys" active={effectiveSort} dir={sortDir} onSort={toggleSort} />
              <th className="tok-th tok-th-link">GMGN</th>
            </tr>
          </thead>
          <tbody key={mode} className="fade-up">
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
              [0, 1, 2, 3, 4].map(i => (
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
                  {mode === "waiting" ? "Queue clear" : "No matches"}
                </td>
              </tr>
            )}
            {!isError && cards.map(c => (
              <TableRow key={c.id} c={c} waiting={mode === "waiting"} hot={mode === "hot"} />
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
            onClick={() => startTransition(() => setPage(p => Math.max(1, p - 1)))}
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
            onClick={() => startTransition(() => setPage(p => Math.min(pages, p + 1)))}
            aria-label="Next page"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
