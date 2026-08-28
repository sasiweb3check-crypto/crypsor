import { useState } from "react";
import { useLocation } from "wouter";
import {
  api, fmtUsd, fmtSignedX,
  type DeskState, type TradeCard, type WatchCard,
} from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";

function Mult({ x }: { x: number | null }) {
  const up = x != null && x >= 1;
  return <span className={`mult ${x == null ? "" : up ? "up" : "down"}`}>{fmtSignedX(x)}</span>;
}

function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  return (
    <div className="pager">
      <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>Prev</button>
      <b>{page} / {pages}</b>
      <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
    </div>
  );
}

function TradeCardRow({ t, onOpen }: { t: TradeCard; onOpen: () => void }) {
  const status = t.status === "trim" ? "trim" : t.status === "exit" || t.status === "dead" ? "exit" : "open";
  return (
    <button type="button" className={`trade ${status}`} onClick={onOpen}>
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

function WatchRow({ w, onOpen }: { w: WatchCard; onOpen: () => void }) {
  return (
    <button type="button" className="watch-card" onClick={onOpen}>
      {w.image
        ? <img src={w.image} alt="" className="thumb" loading="lazy" />
        : <span className="thumb blank" />}
      <div className="card-main">
        <div className="sym">
          ${w.symbol || w.name || w.mint.slice(0, 6)}
          <span className="st trim">watch</span>
        </div>
        <div className="meta">
          {fmtUsd(w.last_mc)} · liq {fmtUsd(w.last_liq)} · score {w.last_score ?? "—"}
        </div>
        <div className="headline">{w.headline || "Agents are still debating this entry."}</div>
        <div className="votes">
          {(w.votes ?? []).map((v) => (
            <span key={v.agent} className={`vote ${v.vote}`}>{v.agent} {v.vote}</span>
          ))}
          {!(w.votes ?? []).length && (
            <>
              <span className="vote yes">{w.yes_votes} yes</span>
              <span className="vote no">{w.no_votes} no</span>
              <span className="vote hold">{w.hold_votes} hold</span>
            </>
          )}
        </div>
      </div>
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
  const [page, setPage] = useState(1);
  const { connected, tick } = useSse();
  const board = usePoll<DeskState>(
    () => api(`api/desk?page=${page}&limit=8`),
    connected ? 45_000 : 10_000,
    [tick, page],
  );
  const d = board.data;
  const wr = d && d.paper.n > 0 ? Math.round((d.paper.wins / d.paper.n) * 100) : null;
  const watch = d?.watch ?? [];

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Crypsor <span>Desk</span></div>
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
          <div className="stat-val" style={{ color: "var(--gold)" }}>{watch.length}</div>
          <div className="stat-label">Watching</div>
        </div>
      </div>

      {watch.length > 0 && (
        <>
          <div className="section-h">Watchlist — agents debating</div>
          {watch.map((w) => (
            <WatchRow key={w.token_id} w={w} onOpen={() => nav(`/p/${w.token_id}`)} />
          ))}
        </>
      )}

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

      <div className="section-h">Open locks</div>
      {board.loading && !d && (
        <>
          <div className="skel" /><div className="skel" /><div className="skel" />
        </>
      )}
      {board.error && <div className="empty err">{board.error}</div>}
      {!board.loading && (d?.open.length ?? 0) === 0 && !board.error && (
        <div className="empty">
          Nothing locked. Candidates sit on the watchlist until vitals, quality, holders, and snapshots agree on the entry.
        </div>
      )}
      {(d?.open ?? []).map((t) => (
        <TradeCardRow key={t.id} t={t} onOpen={() => nav(`/p/${t.token_id}`)} />
      ))}
      <Pager page={d?.page ?? page} pages={d?.pages ?? 1} onPage={setPage} />
      {wr != null && <p className="blurb">Paper hit rate {wr}% on ATH ≥ 2×. GMGN is one tap on the token page.</p>}
    </div>
  );
}
