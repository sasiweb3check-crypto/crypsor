/**
 * TOKEN — journal detail: MC chart from 30s snapshots, call anchors,
 * deep-dive evidence, scan history.
 */
import { useRoute, useLocation } from "wouter";
import { api, fmtUsd, fmtX, timeAgo, type TokenDetail } from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";

function Spark({ points, alertMc }: { points: Array<{ t: number; v: number }>; alertMc: number | null }) {
  if (points.length < 2) return <div className="v-spark v-empty">journal warming up…</div>;
  const W = 640;
  const H = 120;
  const P = 6;
  const vs = points.map((p) => p.v);
  const min = Math.min(...vs, alertMc ?? Infinity);
  const max = Math.max(...vs, alertMc ?? 0);
  const range = max - min || 1;
  const x = (i: number) => P + (i / (points.length - 1)) * (W - P * 2);
  const y = (v: number) => H - P - ((v - min) / range) * (H - P * 2);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const up = vs[vs.length - 1] >= vs[0];
  return (
    <svg className="v-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {alertMc != null && (
        <line x1={P} x2={W - P} y1={y(alertMc)} y2={y(alertMc)} className="v-spark-alert" strokeDasharray="5 5" />
      )}
      <path d={d} fill="none" className={up ? "v-spark-line up" : "v-spark-line down"} />
    </svg>
  );
}

export default function TokenPage() {
  const [, params] = useRoute("/t/:id");
  const [, nav] = useLocation();
  const id = parseInt(params?.id ?? "0", 10);
  const { connected, tick } = useSse(["journal:tick"]);
  const q = usePoll<TokenDetail>(
    () => api(`api/token/${id}`),
    connected ? 30_000 : 15_000,
    [id, tick],
  );

  const d = q.data;
  if (!d) {
    return (
      <div className="v-page">
        <button type="button" className="v-chip" onClick={() => nav("/")}>← vault</button>
        <div className="v-empty">{q.error ?? "loading…"}</div>
      </div>
    );
  }

  const t = d.token;
  const called = t.call_id != null;
  const spark = d.journal
    .filter((j) => j.mc_usd != null && j.mc_usd > 0)
    .map((j) => ({ t: new Date(j.at).getTime(), v: j.mc_usd! }));
  const lastJ = d.journal[d.journal.length - 1];
  const peakX = called && t.alert_mc && t.peak_mc ? t.peak_mc / t.alert_mc : null;
  const nowX = called && t.alert_mc && t.last_mc ? t.last_mc / t.alert_mc : null;

  return (
    <div className="v-page">
      <div className="v-toggle-row">
        <button type="button" className="v-chip" onClick={() => nav("/")}>← vault</button>
        <span className={connected ? "v-live is-live" : "v-live"}>●</span>
      </div>

      <div className="v-token-head">
        {t.image && (
          <img src={t.image} alt="" className="v-thumb v-thumb-lg" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        )}
        <div>
          <h2 className="v-h2">{t.symbol || t.name || t.mint.slice(0, 8)}</h2>
          <div className="v-muted v-mono">
            {t.mint.slice(0, 6)}…{t.mint.slice(-6)}
            {" · "}{t.stage.toUpperCase()}
            {t.safe && " · SAFE TIER"}
            {t.wallet_buys > 0 && ` · ${t.wallet_buys} tracked wallet${t.wallet_buys > 1 ? "s" : ""}`}
          </div>
        </div>
      </div>

      {called && (
        <div className="v-stats">
          <div className="v-stat"><div className="v-stat-val">{fmtUsd(t.alert_mc)}</div><div className="v-stat-label">ALERT MC · {timeAgo(t.called_at)} ago</div></div>
          <div className="v-stat"><div className="v-stat-val">{fmtUsd(t.last_mc)}</div><div className="v-stat-label">NOW {nowX != null ? `(${fmtX(nowX)})` : ""}</div></div>
          <div className="v-stat"><div className="v-stat-val v-green">{fmtUsd(t.peak_mc)}</div><div className="v-stat-label">PEAK {peakX != null ? `(${fmtX(peakX)})` : ""}</div></div>
        </div>
      )}

      <Spark points={spark} alertMc={t.alert_mc} />

      {lastJ && (
        <div className="v-stats v-stats-secondary">
          <div className="v-stat"><div className="v-stat-val">{lastJ.holders ?? "—"}</div><div className="v-stat-label">HOLDERS</div></div>
          <div className="v-stat"><div className="v-stat-val">{fmtUsd(lastJ.liq_usd)}</div><div className="v-stat-label">LIQ</div></div>
          <div className="v-stat"><div className="v-stat-val">{lastJ.bot_pct != null ? `${lastJ.bot_pct.toFixed(0)}%` : "—"}</div><div className="v-stat-label">BOT HOLD</div></div>
          <div className="v-stat"><div className="v-stat-val">{lastJ.smart_count ?? "—"}</div><div className="v-stat-label">SMART</div></div>
        </div>
      )}

      {t.deep?.reasons && (
        <>
          <h3 className="v-h3">DEEP DIVE EVIDENCE</h3>
          <div className="v-kill-reasons">
            {t.deep.reasons.map((r) => <span key={r} className="v-chip is-on">{r}</span>)}
          </div>
        </>
      )}
      {t.kill_reason && (
        <div className="v-empty v-red">killed: {t.kill_reason}</div>
      )}

      <h3 className="v-h3">SCAN HISTORY</h3>
      <div className="v-table">
        <div className="v-tr5 v-thead">
          <span>TIME</span><span>MC</span><span>HOLDERS</span><span>TOP10</span><span>VERDICT</span>
        </div>
        {d.scans.slice(-15).reverse().map((s) => (
          <div key={s.at} className="v-tr5 v-row-static">
            <span className="v-muted">{timeAgo(s.at)}</span>
            <span>{fmtUsd(s.mc_usd)}</span>
            <span>{s.holders ?? "—"}</span>
            <span>{s.top10_pct != null ? `${s.top10_pct.toFixed(0)}%` : "—"}</span>
            <span className={s.pass ? "v-green" : "v-red"}>
              {s.pass ? "PASS" : (s.fail_reasons?.[0] ?? "FAIL")}
            </span>
          </div>
        ))}
      </div>

      <div className="v-links">
        <a className="v-chip" href={`https://gmgn.ai/sol/token/${t.mint}`} target="_blank" rel="noreferrer">GMGN ↗</a>
        <a className="v-chip" href={`https://pump.fun/coin/${t.mint}`} target="_blank" rel="noreferrer">pump.fun ↗</a>
        <a className="v-chip" href={`https://dexscreener.com/solana/${t.mint}`} target="_blank" rel="noreferrer">dexscreener ↗</a>
      </div>
    </div>
  );
}
