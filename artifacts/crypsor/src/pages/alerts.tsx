import { useState } from "react";
import { useLocation } from "wouter";
import { api, timeAgo, type AlertRow } from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";

const KINDS = [
  { id: "book", label: "Book" },
  { id: "trade", label: "Lock" },
  { id: "trim", label: "Trim" },
  { id: "exit", label: "Exit" },
  { id: "all", label: "All" },
];

export default function AlertsPage() {
  const [, nav] = useLocation();
  const [kind, setKind] = useState("book");
  const { connected, tick } = useSse(["alert:new"]);
  const q = usePoll<AlertRow[]>(
    () => api(`api/alerts?kind=${kind}`),
    connected ? 15_000 : 8_000,
    [kind, tick],
  );

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Book</div>
        <div className={`live-dot ${connected ? "on" : ""}`} />
      </header>
      <p className="blurb">
        Every TRADE is locked at that market cap. Exits and trims update here as snapshots move.
      </p>
      <div className="chips">
        {KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            className={kind === k.id ? "chip on" : "chip"}
            onClick={() => setKind(k.id)}
          >
            {k.label}
          </button>
        ))}
      </div>
      {q.loading && !q.data && <div className="empty">Waiting for the book…</div>}
      {q.error && <div className="empty err">{q.error}</div>}
      {(q.data ?? []).length === 0 && !q.loading && !q.error && (
        <div className="empty">No locked trades yet.</div>
      )}
      {(q.data ?? []).map((a) => (
        <button key={a.id} type="button" className={`alert kind-${a.kind}`} onClick={() => nav(`/p/${a.token_id}`)}>
          <div className="k">{a.kind} · {timeAgo(a.at)}</div>
          <h3>{a.title}</h3>
          {a.body && <p>{a.body}</p>}
        </button>
      ))}
    </div>
  );
}
