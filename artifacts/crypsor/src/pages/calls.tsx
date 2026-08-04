/**
 * GEM desk — two things only:
 *   1. Gems: confirmed GEM calls, judged live by survival after the call
 *   2. Log: newly captured tokens streaming in (discovery tape)
 *
 * Live via SSE (prices:desk patches MC, GEM_CALL/token:bought invalidate),
 * with light polling as fallback. Pagination on the gems board.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import {
  cn, formatCompactUsd, formatTimeAgo,
  getGmgnUrl, safeSymbol, safeImageUrl,
} from "@/lib/utils";
import {
  GEMS_FEED_KEY, GEMS_LOG_KEY, GEMS_PAGE_SIZE,
  fetchGems, fetchGemsLog,
  type GemCard, type GemLogRow, type SurvivalLabel,
} from "@/lib/gems-api";
import { useLiveSse } from "@/hooks/use-live-tokens";

function Thumb({ logoUri, address, symbol, size = "md" }: {
  logoUri: string | null;
  address: string;
  symbol: string | null;
  size?: "md" | "sm";
}) {
  const [broken, setBroken] = useState(false);
  const sym = safeSymbol(symbol, address) || "?";
  const cls = size === "sm" ? "gem-thumb gem-thumb-sm" : "gem-thumb";
  if (broken) return <div className={cn(cls, "gem-thumb-fallback")}>{sym.slice(0, 2)}</div>;
  return (
    <img
      src={safeImageUrl(logoUri, address, symbol)}
      alt=""
      className={cls}
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

const SURVIVAL_CLASS: Record<SurvivalLabel, string> = {
  RUNNING: "gem-surv-running",
  HOLDING: "gem-surv-holding",
  COOLING: "gem-surv-cooling",
  FADING: "gem-surv-fading",
};

function GemCardView({ c }: { c: GemCard }) {
  const [, setLocation] = useLocation();
  const sym = safeSymbol(c.symbol, c.address) || "?";
  const gmgn = getGmgnUrl(c.chain, c.address);
  const surv = c.survival;
  const gain = c.gainSinceCallPct;

  return (
    <article
      className="gem-card"
      role="button"
      tabIndex={0}
      onClick={() => setLocation(`/calls/${c.id}`)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setLocation(`/calls/${c.id}`);
        }
      }}
    >
      <div className="gem-card-head">
        <Thumb logoUri={c.logoUri} address={c.address} symbol={c.symbol} />
        <div className="gem-card-id">
          <div className="gem-card-title">
            <span className="gem-card-sym">${sym}</span>
            <span className="gem-badge">GEM {Math.round(c.gemScore)}</span>
          </div>
          <div className="gem-card-sub">
            Called {c.calledAt ? formatTimeAgo(c.calledAt) : "—"} at {formatCompactUsd(c.callMcUsd)}
          </div>
        </div>
        {surv && (
          <div className={cn("gem-surv", SURVIVAL_CLASS[surv.label])}>
            <span className="gem-surv-score">{surv.score}</span>
            <span className="gem-surv-label">{surv.label}</span>
          </div>
        )}
        <a
          href={gmgn}
          target="_blank"
          rel="noreferrer"
          className="gem-card-ext"
          aria-label={`Chart ${sym}`}
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="w-4 h-4" />
        </a>
      </div>

      <div className="gem-card-metrics">
        <div>
          <div className="gem-m-label">Now</div>
          <div className="gem-m-val">{formatCompactUsd(c.currentMcUsd)}</div>
        </div>
        <div>
          <div className="gem-m-label">Gain</div>
          <div className={cn("gem-m-val", (gain ?? 0) > 0 ? "is-gain" : (gain ?? 0) < 0 ? "is-loss" : "")}>
            {fmtPct(gain)}
          </div>
        </div>
        <div>
          <div className="gem-m-label">Peak</div>
          <div className="gem-m-val">
            {c.peakMultiple != null ? `${c.peakMultiple.toFixed(1)}×` : "—"}
          </div>
        </div>
        <div>
          <div className="gem-m-label">Off peak</div>
          <div className={cn("gem-m-val", (c.offPeakPct ?? 0) > 25 ? "is-loss" : "muted")}>
            {c.offPeakPct != null ? `-${Math.max(0, c.offPeakPct).toFixed(0)}%` : "—"}
          </div>
        </div>
      </div>

      {surv && surv.signals.length > 0 && (
        <div className="gem-card-signals">
          {surv.signals.slice(0, 3).map((s) => (
            <span key={s} className="gem-signal">{s}</span>
          ))}
        </div>
      )}
    </article>
  );
}

function LogRow({ r }: { r: GemLogRow }) {
  const [, setLocation] = useLocation();
  const sym = safeSymbol(r.symbol, r.address) || "?";
  const verdict = r.gemVerdict;
  return (
    <button
      type="button"
      className="gem-log-row"
      onClick={() => setLocation(`/calls/${r.id}`)}
    >
      <Thumb logoUri={r.logoUri} address={r.address} symbol={r.symbol} size="sm" />
      <span className="gem-log-sym">${sym}</span>
      <span className="gem-log-mc">{formatCompactUsd(r.currentMcUsd ?? r.detectMcUsd)}</span>
      {verdict && (
        <span className={cn(
          "gem-log-verdict",
          verdict === "GEM" && "is-gem",
          verdict === "WATCH" && "is-watch",
          verdict === "AVOID" && "is-avoid",
        )}>
          {verdict === "GEM" ? `GEM ${r.gemScore != null ? Math.round(r.gemScore) : ""}`
            : verdict === "WATCH" ? `W ${r.gemScore != null ? Math.round(r.gemScore) : ""}`
              : verdict === "AVOID" ? "AVOID" : "—"}
        </span>
      )}
      <span className="gem-log-time">{r.detectedAt ? formatTimeAgo(r.detectedAt) : "—"}</span>
    </button>
  );
}

export default function CallsPage() {
  const { connected } = useLiveSse();
  const [page, setPage] = useState(1);

  const gemsQ = useQuery({
    queryKey: GEMS_FEED_KEY(page),
    queryFn: () => fetchGems(page, GEMS_PAGE_SIZE),
    refetchInterval: connected ? 45_000 : 15_000,
    placeholderData: (prev) => prev,
  });

  const logQ = useQuery({
    queryKey: GEMS_LOG_KEY,
    queryFn: () => fetchGemsLog(25),
    refetchInterval: connected ? 60_000 : 20_000,
  });

  const cards = gemsQ.data?.cards ?? [];
  const pages = gemsQ.data?.pages ?? 1;
  const total = gemsQ.data?.total ?? 0;
  const logRows = logQ.data?.rows ?? [];

  return (
    <div className="gem-page">
      <div className="gem-section-head">
        <h2 className="gem-section-title">
          Gems
          <span className={cn("gem-live-dot", connected && "is-live")} />
        </h2>
        <span className="gem-section-note">
          {total > 0 ? `${total} calls · judged by survival` : "evidence-gated calls"}
        </span>
      </div>

      <div className="gem-feed">
        {gemsQ.isLoading && (
          <>
            <div className="gem-card gem-skeleton" />
            <div className="gem-card gem-skeleton" />
          </>
        )}
        {gemsQ.isError && (
          <div className="gem-empty">
            <p>Couldn’t load gems</p>
            <button type="button" className="desk-btn" onClick={() => void gemsQ.refetch()}>Retry</button>
          </div>
        )}
        {!gemsQ.isLoading && !gemsQ.isError && cards.length === 0 && (
          <div className="gem-empty">
            <p>No GEM calls yet</p>
            <p className="muted">
              The engine only calls a GEM with full evidence — new calls appear here live.
            </p>
          </div>
        )}
        {cards.map((c) => <GemCardView key={c.id} c={c} />)}
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

      <div className="gem-section-head gem-log-head">
        <h2 className="gem-section-title">
          New tokens
          <span className={cn("gem-live-dot", connected && "is-live")} />
        </h2>
        <span className="gem-section-note">live capture log · last 24h</span>
      </div>

      <div className="gem-log">
        {logQ.isLoading && <div className="gem-empty muted">Loading log…</div>}
        {!logQ.isLoading && logRows.length === 0 && (
          <div className="gem-empty muted">No captures yet</div>
        )}
        {logRows.map((r) => <LogRow key={r.id} r={r} />)}
      </div>
    </div>
  );
}
