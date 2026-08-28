import { api, timeAgo, type AgentsState } from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";

const DESK = [
  { id: "intake", title: "Intake", copy: "Reads Helius for buys from wallets you added. Each new mint is admitted." },
  { id: "vitals", title: "Vitals", copy: "DexScreener + pump.fun tape. Scores survival and moves phase." },
  { id: "holders", title: "Holders", copy: "GMGN quality on a free-tier budget — hold share, not bot counts." },
  { id: "reporter", title: "Reporter", copy: "Census and pruning so the free instance stays light." },
  { id: "backtest", title: "Backtest", copy: "Paper 2× after TRADE. Nudges factor weights toward what survived." },
  { id: "alerts", title: "Alerts", copy: "Telegram + live desk for admit, trade, ICU, death, revival." },
];

export default function AgentsPage() {
  const { connected, tick } = useSse(["agent:note"]);
  const q = usePoll<AgentsState>(() => api("api/agents"), connected ? 20_000 : 10_000, [tick]);
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
        One Node process. Dedicated agents rotate on timers — no extra workers, no Redis.
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
