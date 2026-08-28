import { api, timeAgo, type AgentsState } from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";

const DESK = [
  { id: "intake", title: "Intake", copy: "Reads Helius for buys from wallets you added. Each new mint is admitted." },
  { id: "vitals", title: "Vitals", copy: "DexScreener + pump.fun tape. Scores survival and moves phase." },
  { id: "quality", title: "Quality", copy: "Cross-checks Dex, pump.fun coin, and GMGN. Fills gaps. Flags >25% disagreement." },
  { id: "holders", title: "Holders", copy: "GMGN quality on a free-tier budget — hold share, not bot counts." },
  { id: "snapshots", title: "Snapshots", copy: "Two series: pulse every ~2 minutes and confirm every ~5. A lock needs both not dumping." },
  { id: "watch", title: "Watch / debate", copy: "Vitals, quality, holders, and snapshots vote. Unsatisfying entries stay on the watchlist — they are not locked." },
  { id: "book", title: "Book", copy: "Locks TRADE at entry MC only after agreement. Tracks gain, ATH, and tells you when to trim or flatten." },
  { id: "reporter", title: "Reporter", copy: "Census + prune. Not shown on the desk." },
  { id: "backtest", title: "Backtest", copy: "Paper 2× after TRADE. Nudges factor weights toward what survived." },
  { id: "alerts", title: "Alerts", copy: "Telegram + live desk for admit, trade, ICU, death, revival." },
];

export default function AgentsPage() {
  const { connected, tick } = useSse(["agent:note"]);
  const q = usePoll<AgentsState>(() => api("api/agents"), connected ? 45_000 : 10_000, [tick]);
  const d = q.data;
  const paper = d?.paper;
  const wr = paper && paper.judged > 0 ? Math.round((paper.wins / paper.judged) * 100) : null;

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Agents</div>
        <div className={`live-dot ${connected ? "on" : ""}`} />
      </header>
      <p className="blurb">
        Scoring, quality, debate, and phases run here. The desk only shows locks and the watchlist.
      </p>

      <div className="stats">
        <div className="stat">
          <div className="stat-val">{paper?.wins ?? 0}/{paper?.judged ?? 0}</div>
          <div className="stat-label">Paper 2×</div>
        </div>
        <div className="stat">
          <div className="stat-val">{wr != null ? `${wr}%` : "—"}</div>
          <div className="stat-label">Hit rate</div>
        </div>
      </div>

      {d?.report && (
        <div className="factor">
          <div className="factor-top">
            <span>Last report</span>
            <em>{timeAgo(d.report.at)}</em>
          </div>
          <p>{d.report.detail}</p>
        </div>
      )}

      {(d?.report?.suggestions ?? []).length > 0 && (
        <>
          <div className="section-h">Ward suggestions</div>
          {(d?.report?.suggestions ?? []).map((s) => (
            <div key={s.id} className={`alert kind-${s.severity}`}>
              <div className="k">{s.severity}</div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </>
      )}

      {d?.quality?.sources && d.quality.sources.length > 0 && (
        <>
          <div className="section-h">Source health (6h)</div>
          <div className="grid3">
            {d.quality.sources.map((s) => (
              <div key={s.source} className="vit">
                <b>{s.ok}/{s.n}</b>
                <span>{s.source}{s.avg_ms != null ? ` · ${Math.round(s.avg_ms)}ms` : ""}</span>
              </div>
            ))}
            {(d.quality.snapshots ?? []).map((s) => (
              <div key={`snap-${s.band}`} className="vit">
                <b>{s.n}</b>
                <span>{s.band} snaps</span>
              </div>
            ))}
          </div>
        </>
      )}

      {d?.weights && (
        <>
          <div className="section-h">Live weights</div>
          <div className="grid3">
            {Object.entries(d.weights).map(([k, v]) => (
              <div key={k} className="vit"><b>{v.toFixed(2)}</b><span>{k}</span></div>
            ))}
          </div>
        </>
      )}

      <div className="section-h">Desk</div>
      {DESK.map((a) => {
        const last = d?.last24h.find((x) => x.agent === a.id);
        const running = d?.status.running[a.id];
        return (
          <div key={a.id} className="factor">
            <div className="factor-top">
              <span>{a.title}{running ? " · running" : ""}</span>
              <em>{last ? `${last.n} / 24h` : "idle"}</em>
            </div>
            <p>{a.copy}{last ? ` Last note ${timeAgo(last.last_at)}.` : ""}</p>
          </div>
        );
      })}

      <div className="section-h">Log</div>
      <div className="list">
        {(d?.notes ?? []).map((n) => (
          <div key={n.id} className="agent-row">
            <b>{n.agent}<br /><small>{timeAgo(n.at)}</small></b>
            <p>{n.detail}</p>
          </div>
        ))}
        {!d?.notes.length && <div className="row"><span className="blurb">Log is empty until the first tick.</span></div>}
      </div>
    </div>
  );
}
