/**
 * VAULT — the signal dashboard.
 * Stats header · SAFE/NORMAL filter · period tabs · calls table with
 * alert MC → peak MC → peak ×. Live via SSE + polling.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { api, fmtDate, fmtUsd, fmtX, type VaultCall, type VaultStats } from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";

const PERIODS = ["24h", "7d", "30d", "all"] as const;

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="v-stat">
      <div className={accent ? "v-stat-val v-green" : "v-stat-val"}>{value}</div>
      <div className="v-stat-label">{label}</div>
    </div>
  );
}

export default function VaultPage() {
  const [, nav] = useLocation();
  const [safe, setSafe] = useState(true);
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("24h");
  const [sort, setSort] = useState<"time" | "performance">("time");
  const { connected, tick } = useSse(["call:new", "journal:tick"]);

  const q = usePoll<{ calls: VaultCall[]; stats: VaultStats }>(
    () => api(`api/vault?period=${period}&safe=${safe ? 1 : 0}&sort=${sort}`),
    connected ? 30_000 : 12_000,
    [period, safe, sort, tick],
  );

  const stats = q.data?.stats;
  const calls = q.data?.calls ?? [];
  const winRate = useMemo(
    () => stats?.winRate != null ? `${(stats.winRate * 100).toFixed(1)}%` : "—",
    [stats],
  );

  return (
    <div className="v-page">
      <div className="v-toggle-row">
        <button
          type="button"
          className={safe ? "v-toggle is-on" : "v-toggle"}
          onClick={() => setSafe(true)}
        >SAFE FILTER</button>
        <button
          type="button"
          className={!safe ? "v-toggle is-on" : "v-toggle"}
          onClick={() => setSafe(false)}
        >NORMAL VAULT</button>
        <span className={connected ? "v-live is-live" : "v-live"}>●</span>
      </div>
      <p className="v-blurb">
        {safe
          ? "Tight scam filter — higher conviction, fewer signals."
          : "Every call that survived the funnel."}
      </p>

      <div className="v-stats">
        <Stat label="SIGNALS" value={String(stats?.signals ?? 0)} />
        <Stat label="≥ 2× WINNERS" value={String(stats?.winners2x ?? 0)} accent />
        <Stat label="≥ 5× WINNERS" value={String(stats?.winners5x ?? 0)} accent />
        <Stat label="≥ 10× MEGAS" value={String(stats?.winners10x ?? 0)} accent />
      </div>
      <div className="v-stats v-stats-secondary">
        <Stat label="WIN RATE (2×, matured)" value={winRate} accent />
        <Stat label="AVG RETURN" value={stats?.avgReturn != null ? fmtX(stats.avgReturn) : "—"} accent />
        <Stat
          label="BEST"
          value={stats?.bestX != null ? `${stats.bestSymbol ?? "?"} ${fmtX(stats.bestX)}` : "—"}
          accent
        />
      </div>

      <div className="v-controls">
        <span className="v-label">PERIOD</span>
        {PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            className={period === p ? "v-chip is-on" : "v-chip"}
            onClick={() => setPeriod(p)}
          >{p.toUpperCase()}</button>
        ))}
        <span className="v-label v-ml">SORT</span>
        <button type="button" className={sort === "time" ? "v-chip is-on" : "v-chip"} onClick={() => setSort("time")}>Time</button>
        <button type="button" className={sort === "performance" ? "v-chip is-on" : "v-chip"} onClick={() => setSort("performance")}>Performance</button>
      </div>

      <div className="v-table">
        <div className="v-tr v-thead">
          <span>TOKEN</span><span>DATE</span><span>ALERT MC</span><span>PEAK MC</span><span>PEAK</span>
        </div>
        {q.loading && !q.data && <div className="v-empty">loading…</div>}
        {q.error && <div className="v-empty v-red">{q.error}</div>}
        {!q.loading && calls.length === 0 && !q.error && (
          <div className="v-empty">
            no signals in this window yet — the funnel is hunting.
          </div>
        )}
        {calls.map((c) => (
          <button
            key={c.id}
            type="button"
            className="v-tr v-row"
            onClick={() => nav(`/t/${c.token_id}`)}
          >
            <span className="v-token">
              {c.image
                ? <img src={c.image} alt="" className="v-thumb" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                : <span className="v-thumb v-thumb-blank" />}
              <span className="v-sym">{c.symbol || c.name || c.mint.slice(0, 6)}</span>
              {c.safe && <span className="v-safe-dot" title="safe tier">S</span>}
              {c.wallet_buys > 0 && <span className="v-wallet-dot" title="tracked wallet bought">W{c.wallet_buys}</span>}
            </span>
            <span className="v-muted">{fmtDate(c.called_at)}</span>
            <span>{fmtUsd(c.alert_mc)}</span>
            <span>{fmtUsd(c.peak_mc)}</span>
            <span className={c.peak_x != null && c.peak_x >= 2 ? "v-green" : "v-muted"}>
              {fmtX(c.peak_x)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
