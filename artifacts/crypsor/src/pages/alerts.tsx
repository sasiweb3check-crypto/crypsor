import { useState } from "react";
import { useLocation } from "wouter";
import { api, timeAgo, gmgnUrl, type AlertPage } from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";

const KINDS = [
  { id: "book", label: "Book" },
  { id: "watch", label: "Watch" },
  { id: "trade", label: "Lock" },
  { id: "trim", label: "Trim" },
  { id: "exit", label: "Exit" },
  { id: "all", label: "All" },
];

export default function AlertsPage() {
  const [, nav] = useLocation();
  const [kind, setKind] = useState("book");
  const [page, setPage] = useState(1);
  const { connected, tick } = useSse();
  const q = usePoll<AlertPage>(
    () => api(`api/alerts?kind=${kind}&page=${page}&limit=12`),
    connected ? 45_000 : 8_000,
    [kind, page, tick],
  );
  const items = q.data?.items ?? [];
  const pages = q.data?.pages ?? 1;

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Book</div>
        <div className={`live-dot ${connected ? "on" : ""}`} />
      </header>
      <p className="blurb">
        Locks, trims, exits, and the watchlist. A TRADE only prints after the four desks agree and the entry is in zone.
      </p>
      <div className="chips">
        {KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            className={kind === k.id ? "chip on" : "chip"}
            onClick={() => { setKind(k.id); setPage(1); }}
          >
            {k.label}
          </button>
        ))}
      </div>
      {q.loading && !q.data && (
        <>
          <div className="skel" /><div className="skel" />
        </>
      )}
      {q.error && <div className="empty err">{q.error}</div>}
      {items.length === 0 && !q.loading && !q.error && (
        <div className="empty">Nothing in this book yet.</div>
      )}
      {items.map((a) => (
        <div key={a.id} className={`alert kind-${a.kind}`}>
          <button type="button" className="alert-top" onClick={() => nav(`/p/${a.token_id}`)} style={{ width: "100%", display: "flex", background: "none", border: 0, padding: 0, textAlign: "left" }}>
            {a.image
              ? <img src={a.image} alt="" className="thumb sm" />
              : <span className="thumb sm blank" />}
            <div className="card-main">
              <div className="k">{a.kind} · {timeAgo(a.at)}</div>
              <h3>{a.title}</h3>
              {a.body && <p>{a.body}</p>}
            </div>
          </button>
          {a.mint && (
            <a
              className="link"
              href={gmgnUrl(a.mint)}
              target="_blank"
              rel="noreferrer"
              style={{ display: "inline-block", marginTop: 10 }}
            >
              GMGN
            </a>
          )}
        </div>
      ))}
      {pages > 1 && (
        <div className="pager">
          <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
          <b>{page} / {pages} · {q.data?.total ?? 0}</b>
          <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}
