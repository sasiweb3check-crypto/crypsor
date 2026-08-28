import { api, timeAgo, type AgentsState } from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";

const DESK = [
  { id: "intake", title: "Intake", copy: "The only discovery source: Helius buys from wallets you added." },
  { id: "vitals", title: "Read + gate", copy: "DexScreener public tape, pump.fun callback if Dex is blank, then the omo rule set. Missing data is a fail, not a pass." },
  { id: "book", title: "Book", copy: "Locks only on a buying call. Exits use omo's stop, trail, liquidity break, invalidation, take-profit, stale thesis." },
  { id: "reporter", title: "Reporter", copy: "Census + prune. Not shown on the desk." },
  { id: "alerts", title: "Alerts", copy: "Telegram + live desk for buys, stalks, refusals, exits." },
];

export default function AgentsPage() {
  const { connected, tick } = useSse(["agent:note"]);
  const q = usePoll<AgentsState>(() => api("api/agents"), connected ? 45_000 : 10_000, [tick]);
  const d = q.data;
  const paper = d?.paper;
  const wr = paper && paper.judged > 0 ? Math.round((paper.wins / paper.judged) * 100) : null;
  const notes = d?.notes ?? [];

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Stream</div>
        <div className={`live-dot ${connected ? "on" : ""}`} />
      </header>
      <p className="blurb">
        READ / DID / REFUSED. Same decision loop as omotrades, except names come from our tracked wallets.
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
          </div>
        </>
      )}

      <div className="section-h">Loop</div>
      {DESK.map((a) => {
        const live = d?.status.running[a.id];
        const last = d?.status.last[a.id];
        return (
          <div key={a.id} className="factor">
            <div className="factor-top">
              <span>{a.title}{live ? " · running" : ""}</span>
              <em>{last ? timeAgo(new Date(last).toISOString()) : "idle"}</em>
            </div>
            <p>{a.copy}</p>
          </div>
        );
      })}

      <div className="section-h">Recent</div>
      <ol className="stream">
        {notes.slice(0, 24).map((n) => (
          <li key={n.id}>
            <span className="t">{timeAgo(n.at)}</span>
            <b className={`k-${n.action.toLowerCase()}`}>{n.action}</b>
            <span>{n.detail}</span>
          </li>
        ))}
      </ol>
      {!notes.length && <div className="empty">No stream yet — add wallets and wait for a buy.</div>}
    </div>
  );
}
