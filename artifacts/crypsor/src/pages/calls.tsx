/**
 * Token desk — mobile card feed (pump-fullend scoring).
 */
import { startTransition, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import {
  cn, formatCompactUsd, formatTimeAgo,
  getGmgnUrl, safeSymbol, safeImageUrl,
} from "@/lib/utils";
import {
  CALLS_FEED_KEY, DETECT_AGE_OPTIONS, FILTER_BLURB, PAGE_SIZE,
  PAIR_AGE_OPTIONS, PUMP_FILTER_PRESETS, PUMP_SORT_OPTIONS,
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
    return <div className="desk-thumb desk-thumb-fallback">{sym.slice(0, 2)}</div>;
  }
  return (
    <img
      src={safeImageUrl(logoUri, address, symbol)}
      alt=""
      className="desk-thumb"
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

function ageLabel(ts: number | null | undefined): string | null {
  if (!ts || !Number.isFinite(ts)) return null;
  return formatTimeAgo(new Date(ts).toISOString());
}

function TokenCard({ c }: { c: CallCard }) {
  const [, setLocation] = useLocation();
  const sym = safeSymbol(c.symbol, c.address) || "?";
  const gmgn = getGmgnUrl(c.chain, c.address);
  const gain = c.pumpGainSinceDetection ?? c.gainPct;
  const grade = c.pumpGrade;
  const created = ageLabel(c.pumpPairCreatedAt);
  const detected = c.pumpDetectedAt ? ageLabel(c.pumpDetectedAt) : (c.calledAt ? formatTimeAgo(c.calledAt) : null);

  return (
    <article
      className={cn(
        "desk-card",
        grade === "S" && "desk-card-s",
        grade === "A" && "desk-card-a",
        c.pumpBuySignal === "STRONG_BUY" && "desk-card-buy",
      )}
      onClick={() => setLocation(`/calls/${c.id}`)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setLocation(`/calls/${c.id}`);
        }
      }}
    >
      <div className="desk-card-top">
        <TokenThumb logoUri={c.logoUri} address={c.address} symbol={c.symbol} />
        <div className="desk-card-id min-w-0 flex-1">
          <div className="desk-card-title-row">
            <h3 className="desk-card-sym">${sym}</h3>
            {grade && (
              <span className={cn("desk-badge", `desk-badge-grade-${grade.toLowerCase()}`)}>
                {grade}{c.pumpScore != null ? ` ${c.pumpScore}` : ""}
              </span>
            )}
            {c.pumpBuySignal === "STRONG_BUY" && <span className="desk-badge desk-badge-buy">Buy</span>}
            {c.pumpBuySignal === "WATCH" && <span className="desk-badge desk-badge-watch">Watch</span>}
            {c.pumpIntraSignal === "INTRA_NOW" && <span className="desk-badge desk-badge-intra">Intra</span>}
            {c.pumpIntraSignal === "INTRA_SOON" && <span className="desk-badge desk-badge-intra">Soon</span>}
          </div>
          <p className="desk-card-sub">
            {c.pumpRecommendation || "—"}
            {c.walletBuys > 0 && <> · {c.walletBuys} buys</>}
          </p>
        </div>
        <a
          href={gmgn}
          target="_blank"
          rel="noreferrer"
          className="desk-card-chart"
          aria-label={`Chart ${sym}`}
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="w-4 h-4" />
        </a>
      </div>

      <div className="desk-card-metrics">
        <div>
          <div className="desk-metric-label">MC</div>
          <div className="desk-metric-val">{formatCompactUsd(c.currentMcUsd ?? c.pumpMarketCap)}</div>
        </div>
        <div>
          <div className="desk-metric-label">Gain</div>
          <div className={cn("desk-metric-val", (gain ?? 0) > 0 ? "is-gain" : (gain ?? 0) < 0 ? "is-loss" : "")}>
            {fmtPct(gain, 0)}
          </div>
        </div>
        <div>
          <div className="desk-metric-label">ATH</div>
          <div className={cn("desk-metric-val", (c.pumpAthGain ?? 0) > 0 ? "is-gain" : "")}>
            {fmtPct(c.pumpAthGain, 0)}
          </div>
        </div>
        <div>
          <div className="desk-metric-label">Vol</div>
          <div className="desk-metric-val muted">{formatCompactUsd(c.pumpVolume24h ?? c.volume24hUsd)}</div>
        </div>
      </div>

      <div className="desk-card-meta">
        {created && <span>Created {created}</span>}
        {detected && <span>Detected {detected}</span>}
        {c.pumpTags?.[0] && <span className="desk-tag">{c.pumpTags[0].label}</span>}
        {c.pumpTags?.[1] && <span className="desk-tag">{c.pumpTags[1].label}</span>}
      </div>
    </article>
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
  const [pairAge, setPairAge] = useState(0);
  const [detectAge, setDetectAge] = useState(0);
  const [page, setPage] = useState(1);

  const feedPollMs = connected ? 90_000 : 20_000;

  const {
    data, isLoading, isFetching, isError, error, refetch,
  } = useQuery({
    queryKey: CALLS_FEED_KEY(filter, sort, page, minScore, pairAge, detectAge),
    queryFn: () => fetchCallsFeed(filter, page, PAGE_SIZE, sort, minScore, pairAge, detectAge),
    refetchInterval: feedPollMs,
    staleTime: connected ? 12_000 : 4_000,
    placeholderData: (prev) => (prev && prev.filter === filter ? prev : undefined),
    retry: 2,
  });

  const cards = data?.cards ?? [];
  const total = data?.total ?? 0;
  const pages = data?.pages ?? 1;
  const showLoading = isLoading && cards.length === 0;

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
      queryKey: CALLS_FEED_KEY(f, sort, 1, minScore, pairAge, detectAge),
      queryFn: () => fetchCallsFeed(f, 1, PAGE_SIZE, sort, minScore, pairAge, detectAge),
      staleTime: 10_000,
    });
  };

  const pageHint = useMemo(() => FILTER_BLURB[filter], [filter]);

  return (
    <div className="desk-page">
      <div className="desk-toolbar">
        <div className="desk-chips" role="tablist" aria-label="Filters">
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
                className={cn("desk-chip", active && "desk-chip-on")}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        <div className="desk-controls">
          <label className="desk-ctrl">
            <span>Sort</span>
            <select
              value={sort}
              onChange={(e) => startTransition(() => {
                setSort(e.target.value as PumpSortId);
                setPage(1);
              })}
              aria-label="Sort"
            >
              {PUMP_SORT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="desk-ctrl">
            <span>Created</span>
            <select
              value={pairAge}
              onChange={(e) => startTransition(() => {
                setPairAge(Number(e.target.value));
                setPage(1);
              })}
              aria-label="Creation age"
            >
              {PAIR_AGE_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="desk-ctrl">
            <span>Detected</span>
            <select
              value={detectAge}
              onChange={(e) => startTransition(() => {
                setDetectAge(Number(e.target.value));
                setPage(1);
              })}
              aria-label="Detection age"
            >
              {DETECT_AGE_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="desk-ctrl desk-ctrl-score">
            <span>Min {minScore}</span>
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
              aria-label="Minimum score"
            />
          </label>
        </div>

        <div className="desk-status">
          <span>
            {total} tokens
            {isFetching && !showLoading ? " · …" : ""}
            {connected ? " · Live" : " · Sync"}
          </span>
          <span className="desk-status-blurb">{pageHint}</span>
        </div>
      </div>

      <div className="desk-feed" key={`${filter}-${sort}-${minScore}-${pairAge}-${detectAge}-${page}`}>
        {showLoading && (
          <>
            <div className="desk-card desk-skeleton" />
            <div className="desk-card desk-skeleton" />
            <div className="desk-card desk-skeleton" />
          </>
        )}
        {isError && (
          <div className="desk-empty">
            <p>Couldn’t load desk</p>
            <p className="muted">{error instanceof Error ? error.message : "API waking up"}</p>
            <button type="button" className="desk-btn" onClick={() => void refetch()}>Retry</button>
          </div>
        )}
        {!showLoading && !isError && cards.length === 0 && (
          <div className="desk-empty">
            <p>No tokens match</p>
            <p className="muted">Try All, lower min score, or clear age filters</p>
          </div>
        )}
        {cards.map((c) => <TokenCard key={c.id} c={c} />)}
      </div>

      {pages > 1 && (
        <div className="desk-pager">
          <button
            type="button"
            className="desk-btn"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="w-4 h-4" /> Prev
          </button>
          <span className="font-mono-num">{page} / {pages}</span>
          <button
            type="button"
            className="desk-btn"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
