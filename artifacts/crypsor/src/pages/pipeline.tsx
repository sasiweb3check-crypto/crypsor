/**
 * PIPELINE — the funnel, live: discovery → tracking → deep dive → called,
 * currently tracked tokens with their latest scan, recent kills with
 * reasons (the journal that refines the filters).
 */
import { useLocation } from "wouter";
import { api, fmtUsd, timeAgo, type FunnelState } from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";

export default function PipelinePage() {
  const [, nav] = useLocation();
  const { connected, tick } = useSse(["funnel:activity", "call:new"]);
  const q = usePoll<FunnelState>(() => api("api/funnel"), connected ? 20_000 : 10_000, [tick]);

  const d = q.data;
  const stageCount = (s: string) => d?.counts?.[s] ?? 0;

  return (
    <div className="v-page">
      <div className="v-toggle-row">
        <h2 className="v-h2">PIPELINE</h2>
        <span className={connected ? "v-live is-live" : "v-live"}>●</span>
      </div>

      <div className="v-stats">
        <div className="v-stat">
          <div className="v-stat-val">{stageCount("tracking") + stageCount("deepdive") + stageCount("called") + stageCount("killed")}</div>
          <div className="v-stat-label">ENTERED (24H)</div>
        </div>
        <div className="v-stat">
          <div className="v-stat-val">{stageCount("tracking")}</div>
          <div className="v-stat-label">TRACKING</div>
        </div>
        <div className="v-stat">
          <div className="v-stat-val v-green">{stageCount("called")}</div>
          <div className="v-stat-label">CALLED</div>
        </div>
        <div className="v-stat">
          <div className="v-stat-val v-red">{stageCount("killed")}</div>
          <div className="v-stat-label">KILLED</div>
        </div>
      </div>

      <h3 className="v-h3">UNDER WATCH</h3>
      <div className="v-table">
        <div className="v-tr5 v-thead">
          <span>TOKEN</span><span>MC</span><span>HOLDERS</span><span>STREAK</span><span>LAST SCAN</span>
        </div>
        {(d?.tracking ?? []).map((t) => (
          <button key={t.id} type="button" className="v-tr5 v-row" onClick={() => nav(`/t/${t.id}`)}>
            <span className="v-token">
              <span className="v-sym">{t.symbol || t.mint.slice(0, 6)}</span>
              {t.wallet_buys > 0 && <span className="v-wallet-dot">W{t.wallet_buys}</span>}
              {t.source === "wallet_buy" && <span className="v-src">wallet</span>}
            </span>
            <span>{fmtUsd(t.mc_usd)}</span>
            <span>{t.holders ?? "—"}</span>
            <span className={t.pass === false ? "v-red" : "v-green"}>
              {t.pass_streak}/{3} {t.pass === false && t.fail_reasons?.length ? `· ${t.fail_reasons[0]}` : ""}
            </span>
            <span className="v-muted">{t.scans_total} scans</span>
          </button>
        ))}
        {(d?.tracking ?? []).length === 0 && <div className="v-empty">nothing under watch right now</div>}
      </div>

      <h3 className="v-h3">KILL REASONS (24H)</h3>
      <div className="v-kill-reasons">
        {(d?.killReasons ?? []).map((k) => (
          <span key={k.reason} className="v-chip">{k.reason || "?"} · {k.n}</span>
        ))}
        {(d?.killReasons ?? []).length === 0 && <span className="v-muted">none yet</span>}
      </div>

      <h3 className="v-h3">RECENT KILLS</h3>
      <div className="v-table">
        {(d?.recentKills ?? []).map((k) => (
          <div key={k.mint} className="v-tr3 v-row-static">
            <span className="v-sym">{k.symbol || k.mint.slice(0, 6)}</span>
            <span className="v-red">{k.kill_reason}</span>
            <span className="v-muted">{timeAgo(k.discovered_at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
