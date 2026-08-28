import { useLocation } from "wouter";
import {
  api, fmtUsd, fmtSignedX, timeAgo,
  type DeskState, type TradeCard,
} from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";

function Mult({ x }: { x: number | null }) {
  const up = x != null && x >= 1;
  return <span className={`mult ${x == null ? "" : up ? "up" : "down"}`}>{fmtSignedX(x)}</span>;
}

function TradeCardRow({ t, onOpen }: { t: TradeCard; onOpen: () => void }) {
  const status = t.status === "trim" ? "trim" : t.status === "exit" || t.status === "dead" ? "exit" : "open";
  return (
    <button type="button" className="trade" onClick={onOpen}>
      {t.image
        ? <img src={t.image} alt="" className="thumb" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        : <span className="thumb blank" />}
      <div className="card-main">
        <div className="sym">
          ${t.symbol || t.name || t.mint.slice(0, 6)}
          <span className={`st ${status}`}>{status}</span>
        </div>
        <div className="meta">
          {fmtUsd(t.last_mc)} now · in {fmtUsd(t.entry_mc)} · ATH {fmtSignedX(t.ath_x)}
        </div>
        <div className="plan">{t.exit_title || "Watch the lock"}</div>
      </div>
      <Mult x={t.gain_x} />
    </button>
  );
}

function Performer({ t, onOpen }: { t: TradeCard; onOpen: () => void }) {
  return (
    <button type="button" className="performer" onClick={onOpen}>
      {t.image ? <img src={t.image} alt="" className="thumb sm" /> : <span className="thumb sm blank" />}
      <span className="p-sym">${t.symbol || t.mint.slice(0, 4)}</span>
      <span className="p-ath">ATH {fmtSignedX(t.ath_x)}</span>
      <span className={`p-now ${(t.gain_x ?? 0) >= 1 ? "up" : "down"}`}>{fmtSignedX(t.gain_x)}</span>
    </button>
  );
}

export default function WardPage() {
  const [, nav] = useLocation();
  const { connected, tick } = useSse(["alert:new", "vitals:tick"]);
  const board = usePoll<DeskState>(
    () => api("api/desk"),
    connected ? 18_000 : 10_000,
    [tick],
  );
  const d = board.data;
  const wr = d && d.paper.n > 0 ? Math.round((d.paper.wins / d.paper.n) * 100) : null;

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Crypsor <span>Trades</span></div>
        <div className={`live-dot ${connected ? "on" : ""}`} />
      </header>

      <div className="stats">
        <div className="stat">
          <div className="stat-val">{d?.paper.open ?? 0}</div>
          <div className="stat-label">Open locks</div>
        </div>
        <div className="stat">
          <div className="stat-val" style={{ color: "var(--sage)" }}>{d?.paper.wins ?? 0}/{d?.paper.n ?? 0}</div>
          <div className="stat-label">Hit 2×</div>
        </div>
        <div className="stat">
          <div className="stat-val">{d?.paper.avgAth != null ? fmtSignedX(d.paper.avgAth) : "—"}</div>
          <div className="stat-label">Avg ATH</div>
        </div>
        <div className="stat">
          <div className="stat-val" style={{ color: "var(--gold)" }}>{wr != null ? `${wr}%` : "—"}</div>
          <div className="stat-label">Paper rate</div>
        </div>
      </div>

      {(d?.performers ?? []).length > 0 && (
        <>
          <div className="section-h">Performers</div>
          <div className="performers">
            {d!.performers.map((t) => (
              <Performer key={t.id} t={t} onOpen={() => nav(`/p/${t.token_id}`)} />
            ))}
          </div>
        </>
      )}

      <div className="section-h">Open</div>
      {board.loading && !d && <div className="empty">Opening the book…</div>}
      {board.error && <div className="empty err">{board.error}</div>}
      {!board.loading && (d?.open.length ?? 0) === 0 && !board.error && (
        <div className="empty">
          No locked trades yet. When a wallet buy clears the gate, it locks here at that MC.
        </div>
      )}
      {(d?.open ?? []).map((t) => (
        <TradeCardRow key={t.id} t={t} onOpen={() => nav(`/p/${t.token_id}`)} />
      ))}
    </div>
  );
}
