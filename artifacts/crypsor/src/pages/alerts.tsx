import { useState } from "react";
import { useLocation } from "wouter";
import { api, timeAgo, type AlertRow } from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";

const KINDS = ["", "trade", "admit", "critical", "deceased", "revived"];

export default function AlertsPage() {
  const [, nav] = useLocation();
  const [kind, setKind] = useState("");
  const { connected, tick } = useSse(["alert:new"]);
  const q = usePoll<AlertRow[]>(
    () => api(`api/alerts${kind ? `?kind=${kind}` : ""}`),
    connected ? 15_000 : 8_000,
    [kind, tick],
  );

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Alerts</div>
        <div className={`live-dot ${connected ? "on" : ""}`} />
      </header>
      <p className="blurb">
        Admission, trade, ICU, death, and revival — each with the token facts used to decide.
      </p>
      <div className="chips">
        {KINDS.map((k) => (
          <button
            key={k || "all"}
            type="button"
            className={kind === k ? "chip on" : "chip"}
            onClick={() => setKind(k)}
          >
            {k || "All"}
          </button>
        ))}
      </div>
      {q.loading && !q.data && <div className="empty">Waiting for the alert desk…</div>}
      {q.error && <div className="empty err">{q.error}</div>}
      {(q.data ?? []).length === 0 && !q.loading && !q.error && (
        <div className="empty">No alerts yet. A wallet buy starts the chart.</div>
      )}
      {(q.data ?? []).map((a) => (
        <button key={a.id} type="button" className={`alert kind-${a.kind}`} onClick={() => nav(`/p/${a.token_id}`)}>
          <div className="k">{a.kind} · {timeAgo(a.at)}{a.telegram_sent ? " · tg" : ""}</div>
          <h3>{a.title}</h3>
          {a.body && <p>{a.body}</p>}
        </button>
      ))}
    </div>
  );
}
