import { useState } from "react";
import { useLocation } from "wouter";
import { api, type TokenBoard, type TokenStatus } from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";
import { TokenRow, PerformerCard } from "../components/pass-card";

const FILTERS: Array<{ id: "all" | TokenStatus; label: string }> = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "live", label: "Live" },
  { id: "dead", label: "Archived" },
];

export default function DeskPage() {
  const [, nav] = useLocation();
  const [q, setQ] = useState("");
  const [typed, setTyped] = useState("");
  const [status, setStatus] = useState<"all" | TokenStatus>("all");
  const [page, setPage] = useState(1);
  const { connected, tick } = useSse();
  const board = usePoll<TokenBoard>(
    () => api(`api/tokens?page=${page}&limit=20&status=${status}&q=${encodeURIComponent(q)}`),
    20_000,
    [page, status, q, tick],
  );
  const d = board.data;
  const items = d?.items ?? [];
  const performers = d?.performers ?? [];
  const census = d?.census;
  const open = (id: number) => nav(`/p/${id}`);

  return (
    <div className="page">
      <div className="head">
        <h1>Wallet buys</h1>
        <span className={`dot${connected ? " on" : ""}`} title={connected ? "live" : "polling"} />
        <span className="muted">{connected ? "live" : "polling"}</span>
      </div>

      {performers.length > 0 ? (
        <>
          <div className="h">Performers</div>
          <div className="performers">
            {performers.map((p) => (
              <PerformerCard key={p.id} p={p} onOpen={() => open(p.id)} />
            ))}
          </div>
        </>
      ) : null}

      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQ(typed.trim());
        }}
      >
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Search symbol, name, mint"
          aria-label="Search tokens"
        />
        <button type="submit" className="chip on">Search</button>
      </form>

      <div className="toolbar">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={status === f.id ? "chip on" : "chip"}
            onClick={() => { setStatus(f.id); setPage(1); }}
          >
            {f.label}
            {census ? (
              <span className="n">
                {f.id === "all" ? census.all : census[f.id]}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {board.loading && !d ? <div className="skel" /> : null}
      {board.error ? <div className="empty err">{board.error}</div> : null}
      {!board.loading && items.length === 0 && !board.error ? (
        <div className="empty">No wallet-buy tokens in this slice.</div>
      ) : null}
      <div className="rows">
        {items.map((p) => (
          <TokenRow key={p.id} p={p} onOpen={() => open(p.id)} />
        ))}
      </div>

      {(d?.pages ?? 1) > 1 ? (
        <div className="pager">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            Prev
          </button>
          <span className="muted">{d?.page} / {d?.pages} · {d?.total}</span>
          <button
            type="button"
            disabled={page >= (d?.pages ?? 1)}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}
