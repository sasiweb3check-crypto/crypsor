/**
 * GEM token detail — lightweight and fast.
 *
 * One request (api/gems/token/:id): token + tape sparkline + generated story.
 * No creator-history fetches, no heavy joins. Live via SSE MC patches +
 * short polling. Built for a trader's 10-second read:
 *   headline story → sparkline → survival → key numbers → links.
 */
import { useQuery } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { ArrowLeft, ExternalLink, RefreshCw } from "lucide-react";
import { useState } from "react";
import {
  cn, formatCompactUsd, formatTimeAgo,
  getGmgnUrl, safeSymbol, safeImageUrl,
} from "@/lib/utils";
import {
  GEM_DETAIL_KEY, fetchGemDetail,
  type GemDetail, type SurvivalLabel,
} from "@/lib/gems-api";
import { useLiveSse } from "@/hooks/use-live-tokens";

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

/** Minimal SVG sparkline — no chart lib, renders the MC tape. */
function Spark({ points, callMc }: { points: Array<{ t: number; mc: number }>; callMc: number | null }) {
  if (points.length < 2) {
    return <div className="gem-spark gem-spark-empty muted">Tape warming up…</div>;
  }
  const W = 320;
  const H = 84;
  const PAD = 4;
  const mcs = points.map((p) => p.mc);
  const min = Math.min(...mcs, callMc ?? Infinity);
  const max = Math.max(...mcs, callMc ?? 0);
  const range = max - min || 1;
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = (mc: number) => H - PAD - ((mc - min) / range) * (H - PAD * 2);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.mc).toFixed(1)}`).join(" ");
  const up = points[points.length - 1].mc >= points[0].mc;
  const callY = callMc != null && callMc > 0 ? y(callMc) : null;

  return (
    <svg className="gem-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Market cap trend">
      {callY != null && (
        <line x1={PAD} x2={W - PAD} y1={callY} y2={callY} className="gem-spark-call" strokeDasharray="4 4" />
      )}
      <path d={d} fill="none" className={up ? "gem-spark-line is-up" : "gem-spark-line is-down"} />
    </svg>
  );
}

function StoryCard({ story }: { story: GemDetail["story"] }) {
  return (
    <section className={cn("gem-story", `gem-story-${story.mood}`)}>
      <h3 className="gem-story-headline">{story.headline}</h3>
      {story.lines.map((l) => (
        <p key={l} className="gem-story-line">{l}</p>
      ))}
    </section>
  );
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="gem-stat">
      <div className="gem-m-label">{label}</div>
      <div className={cn("gem-m-val", cls)}>{value}</div>
    </div>
  );
}

export default function GemDetailPage() {
  const [, params] = useRoute("/calls/:id");
  const [, legacyParams] = useRoute("/tokens/:id");
  const [, setLocation] = useLocation();
  const { connected } = useLiveSse();
  const id = parseInt(params?.id ?? legacyParams?.id ?? "0", 10);
  const [copied, setCopied] = useState(false);

  const q = useQuery({
    queryKey: GEM_DETAIL_KEY(id),
    queryFn: () => fetchGemDetail(id),
    enabled: Number.isFinite(id) && id > 0,
    refetchInterval: connected ? 20_000 : 10_000,
    placeholderData: (prev) => prev,
  });

  const d = q.data;
  const c = d?.card;

  if (q.isLoading && !d) {
    return (
      <div className="gem-page">
        <div className="gem-card gem-skeleton" style={{ minHeight: "12rem" }} />
      </div>
    );
  }
  if (q.isError || !c) {
    return (
      <div className="gem-page">
        <div className="gem-empty">
          <p>Couldn’t load token</p>
          <button type="button" className="desk-btn" onClick={() => void q.refetch()}>
            <RefreshCw className="w-4 h-4" /> Retry
          </button>
        </div>
      </div>
    );
  }

  const sym = safeSymbol(c.symbol, c.address) || "?";
  const gmgn = getGmgnUrl(c.chain, c.address);
  const pumpUrl = `https://pump.fun/coin/${c.address}`;
  const surv = c.survival;
  const flow = d.flow;
  const flowTotal = flow ? flow.buys5m + flow.sells5m : 0;
  const buyPct = flow && flowTotal > 0 ? Math.round((flow.buys5m / flowTotal) * 100) : null;

  const copyAddress = () => {
    void navigator.clipboard?.writeText(c.address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="gem-page">
      <div className="gem-detail-nav">
        <button type="button" className="desk-btn" onClick={() => setLocation("/")}>
          <ArrowLeft className="w-4 h-4" /> Desk
        </button>
        <span className={cn("gem-live-dot", (connected || d.live) && "is-live")} />
        <span className="gem-section-note">{d.live ? "live price" : "synced"}</span>
      </div>

      <header className="gem-detail-head">
        <img
          src={safeImageUrl(c.logoUri, c.address, c.symbol)}
          alt=""
          className="gem-thumb gem-thumb-lg"
          onError={(e) => { (e.target as HTMLImageElement).style.visibility = "hidden"; }}
        />
        <div className="gem-detail-id">
          <div className="gem-card-title">
            <span className="gem-detail-sym">${sym}</span>
            {c.gemVerdict === "GEM" && <span className="gem-badge">GEM {Math.round(c.gemScore)}</span>}
            {c.gemVerdict === "WATCH" && <span className="gem-badge gem-badge-watch">WATCH {Math.round(c.gemScore)}</span>}
            {c.gemVerdict === "AVOID" && <span className="gem-badge gem-badge-avoid">AVOID</span>}
          </div>
          <button type="button" className="gem-addr" onClick={copyAddress}>
            {copied ? "copied!" : `${c.address.slice(0, 4)}…${c.address.slice(-4)}`}
          </button>
        </div>
        {surv && (
          <div className={cn("gem-surv gem-surv-lg", SURVIVAL_CLASS[surv.label])}>
            <span className="gem-surv-score">{surv.score}</span>
            <span className="gem-surv-label">{surv.label}</span>
          </div>
        )}
      </header>

      <section className="gem-detail-price">
        <div className="gem-detail-mc">
          <span className="gem-detail-mc-now">{formatCompactUsd(c.currentMcUsd)}</span>
          {c.callMcUsd != null && (
            <span className={cn(
              "gem-detail-gain",
              (c.gainSinceCallPct ?? 0) >= 0 ? "is-gain" : "is-loss",
            )}>
              {fmtPct(c.gainSinceCallPct)} since call
            </span>
          )}
        </div>
        <Spark points={d.spark} callMc={c.callMcUsd} />
        {c.callMcUsd != null && (
          <div className="gem-spark-legend muted">
            call {formatCompactUsd(c.callMcUsd)}
            {c.peakMultiple != null && <> · peak {c.peakMultiple.toFixed(1)}×</>}
            {c.offPeakPct != null && c.offPeakPct > 3 && <> · {Math.round(c.offPeakPct)}% off peak</>}
          </div>
        )}
      </section>

      <StoryCard story={d.story} />

      <section className="gem-detail-stats">
        <Stat label="Liquidity" value={formatCompactUsd(c.liqUsd)} />
        <Stat label="Vol 24h" value={formatCompactUsd(c.vol24hUsd)} />
        <Stat
          label="Buys 5m"
          value={buyPct != null ? `${buyPct}%` : "—"}
          cls={buyPct != null ? (buyPct >= 60 ? "is-gain" : buyPct <= 40 ? "is-loss" : "") : ""}
        />
        <Stat label="Holders" value={c.holderCount != null && c.holderCount > 0 ? String(c.holderCount) : "—"} />
        <Stat label="Top 10" value={c.top10Pct != null && c.top10Pct > 0 ? `${Math.round(c.top10Pct)}%` : "—"} />
        <Stat
          label="Bots"
          value={
            (c.sniperCount ?? 0) + (c.bundlerCount ?? 0) > 0
              ? `${(c.sniperCount ?? 0) + (c.bundlerCount ?? 0)}`
              : "0"
          }
        />
        <Stat label="Tracked" value={`${c.trackedWallets} wallet${c.trackedWallets === 1 ? "" : "s"}`} />
        <Stat
          label="Age"
          value={c.pairAgeMin != null
            ? c.pairAgeMin < 60 ? `${c.pairAgeMin}m` : `${Math.round(c.pairAgeMin / 60)}h`
            : "—"}
        />
      </section>

      {c.gemVetoes.length > 0 && (
        <section className="gem-vetoes">
          {c.gemVetoes.map((v) => <span key={v} className="gem-veto">{v.replace(/_/g, " ")}</span>)}
        </section>
      )}

      {surv && surv.signals.length > 0 && (
        <div className="gem-card-signals">
          {surv.signals.map((s) => <span key={s} className="gem-signal">{s}</span>)}
        </div>
      )}

      <section className="gem-detail-links">
        <a href={gmgn} target="_blank" rel="noreferrer" className="desk-btn">
          GMGN <ExternalLink className="w-3.5 h-3.5" />
        </a>
        <a href={pumpUrl} target="_blank" rel="noreferrer" className="desk-btn">
          pump.fun <ExternalLink className="w-3.5 h-3.5" />
        </a>
        {c.socials.twitter && (
          <a href={c.socials.twitter} target="_blank" rel="noreferrer" className="desk-btn">
            X <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
        {c.socials.telegram && (
          <a href={c.socials.telegram} target="_blank" rel="noreferrer" className="desk-btn">
            TG <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
      </section>

      <p className="gem-detail-meta muted">
        Detected {c.detectedAt ? formatTimeAgo(c.detectedAt) : "—"}
        {c.calledAt && <> · GEM call {formatTimeAgo(c.calledAt)}</>}
        {" · "}confidence {(c.gemConfidence * 100).toFixed(0)}%
      </p>
    </div>
  );
}
