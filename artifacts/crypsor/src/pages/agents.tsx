import { useState } from "react";
import { useLocation } from "wouter";
import { api, timeAgo, type AgentsState } from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";

const LANES = [
  { id: "all", label: "All logs" },
  { id: "pass", label: "Passes" },
  { id: "book", label: "Book" },
] as const;

const LOOP = [
  { id: "intake", title: "Intake", copy: "Tracked-wallet buys. The only discovery source." },
  { id: "vitals", title: "Live gate", copy: "Fresh Dex / pump.fun prints on live passes first." },
  { id: "archive", title: "Archive sample", copy: "Random dead/exited passes — three at a time — watching for momentum." },
  { id: "book", title: "Book", copy: "Exit rules on live passes. Stats roll up by day." },
];

export default function AgentsPage() {
  const [, nav] = useLocation();
  const [lane, setLane] = useState<(typeof LANES)[number]["id"]>("all");
  const { connected, tick } = useSse();
  const q = usePoll<AgentsState>(
    () => api(`api/agents?lane=${lane}`),
    connected ? 30_000 : 12_000,
    [tick, lane],
  );
  const d = q.data;
  const notes = d?.notes ?? [];

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Logs</div>
        <div className={`live-dot ${connected ? "on" : ""}`} />
      </header>
      <p className="blurb">
        Full archive. The desk stays quiet — refusals and tape reads land here, not in the live stream.
      </p>

      <div className="chips">
        {LANES.map((k) => (
          <button
            key={k.id}
            type="button"
            className={lane === k.id ? "chip on" : "chip"}
            onClick={() => setLane(k.id)}
          >
            {k.label}
          </button>
        ))}
      </div>

      <div className="section-h">Loop</div>
      {LOOP.map((a) => {
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

      <div className="section-h">Archive</div>
      <ol className="stream">
        {notes.map((n) => (
          <li key={n.id}>
            <span className="t">{timeAgo(n.at)}</span>
            <b className={`k-${n.action.toLowerCase()}`}>{n.action}</b>
            {n.token_id
              ? <button type="button" className="log-link" onClick={() => nav(`/p/${n.token_id}`)}>{n.detail}</button>
              : <span>{n.detail}</span>}
          </li>
        ))}
      </ol>
      {!notes.length && <div className="empty">No logs yet — add wallets and wait for a buy.</div>}
    </div>
  );
}
