import { useState } from "react";
import { useLocation } from "wouter";
import { api, type GainMatrix, type TokenBoard, type TokenStatus } from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";
import { TokenRow, PerformerCard, ScoreStrip } from "../components/pass-card";

const FILTERS: Array<{ id: "all" | TokenStatus; label: string }> = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "live", label: "Live" },
  { id: "dead", label: "Archived" },
];

const MATRIX_RUNGS = ["2", "5", "10"] as const;

function MatrixStrip({ matrix }: { matrix: GainMatrix }) {
  return (
    <section className="matrix" aria-label="Early band 2x 5x 10x">
      <div className="h">Detected $5k–$30k · {matrix.n}</div>
      <div className="matrix-grid">
        {MATRIX_RUNGS.map((m) => (
          <div key={`now-${m}`} className="num">
            <div className="k">≥{m}× now</div>
            <div className="v">{matrix.now[m]?.pct.toFixed(1)}%</div>
            <div className="muted">{matrix.now[m]?.n ?? 0}</div>
          </div>
        ))}
        {MATRIX_RUNGS.map((m) => (
          <div key={`peak-${m}`} className="num">
            <div className="k">≥{m}× peak</div>
            <div className="v">{matrix.peak[m]?.pct.toFixed(1)}%</div>
            <div className="muted">{matrix.peak[m]?.n ?? 0}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function DeskPage() {
  const [, nav] = useLocation();
  const [q, setQ] = useState("");
  const [typed, setTyped] = useState("");
  const [status, setStatus] = useState<"all" | TokenStatus>("all");
  const [early, setEarly] = useState(false);
  const [page, setPage] = useState(1);
  const { connected, tick } = useSse();
  const band = early ? "early" : "all";
  const board = usePoll<TokenBoard>(
    () => api(`api/tokens?page=${page}&limit=20&status=${status}&band=${band}&q=${encodeURIComponent(q)}`),
    20_000,
    [page, status, band, q, tick],
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
          <div className="h">{early ? "Early performers" : "Performers"}</div>
          <div className="performers">
            {performers.map((p) => (
              <PerformerCard key={p.id} p={p} onOpen={() => open(p.id)} />
            ))}
          </div>
        </>
      ) : null}

      {early && d?.matrix ? <MatrixStrip matrix={d.matrix} /> : null}
      {d?.scoreStats ? <ScoreStrip stats={d.scoreStats} /> : null}

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
        <button
          type="button"
          className={early ? "chip on" : "chip"}
          aria-pressed={early}
          onClick={() => { setEarly((on) => !on); setPage(1); }}
        >
          $5–30k
          {census ? <span className="n">{census.early}</span> : null}
        </button>
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
