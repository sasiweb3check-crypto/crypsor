import { useState } from "react";
import { useLocation } from "wouter";
import {
  api, fmtUsd, fmtSignedX, timeAgo,
  type DeskState, type TradeCard, type WatchCard, type VerdictCard, type StreamRow, type Check,
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

function Checks({ checks }: { checks: Check[] }) {
  if (!checks.length) return null;
  return (
    <ul className="checks">
      {checks.map((c) => (
        <li key={c.text} className={c.hold === true ? "holds" : c.hold === false ? "fails" : "unread"}>
          {c.hold === true ? "holds" : c.hold === false ? "fails" : "unread"} — {c.text}
        </li>
      ))}
    </ul>
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
        <div className="plan">{t.exit_title || "Hold the lock"}</div>
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
          <span className="st trim">stalk</span>
        </div>
        <div className="meta">
          {fmtUsd(w.last_mc)} · liq {fmtUsd(w.last_liq)}
        </div>
        <div className="headline">{w.headline || "Waiting for buyers to take the live hour."}</div>
      </div>
    </button>
  );
}

function VerdictRow({ v, onOpen }: { v: VerdictCard; onOpen: () => void }) {
  const r = v.last_reasons;
  const call = (r?.call || v.last_verdict || "pass").toLowerCase();
  return (
    <button type="button" className={`verdict-card call-${call}`} onClick={onOpen}>
      <div className="verdict-top">
        <b>${v.symbol || v.name || v.mint.slice(0, 6)}</b>
        <span className={`st ${call === "buying" || call === "holding" ? "open" : call === "stalking" ? "trim" : "exit"}`}>{call}</span>
        <em>{timeAgo(v.last_scan_at)}</em>
      </div>
      <div className="meta">{fmtUsd(v.last_mc)} · liq {fmtUsd(v.last_liq)} · {v.wallet_buys} wallets</div>
      {r?.qualityNote && <div className="quality-note">{r.qualityNote}</div>}
      <Checks checks={r?.checks ?? []} />
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
  const verdicts = d?.verdicts ?? [];
  const stream = d?.stream ?? [];

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Crypsor <span>Desk</span></div>
        <div className={`live-dot ${connected ? "on" : ""}`} />
      </header>

      <p className="blurb">
        Wallet buys in. DexScreener tape, pump.fun callback if Dex is blank. Same gate as omo — buy, stalk, or pass.
        Names around $2k MC are already rugged and never suggested.
      </p>

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
          <div className="stat-label">Stalking</div>
        </div>
      </div>

      {verdicts.length > 0 && (
        <>
          <div className="section-h">How it decided</div>
          {verdicts.map((v) => (
            <VerdictRow key={v.id} v={v} onOpen={() => nav(`/p/${v.id}`)} />
          ))}
        </>
      )}

      {watch.length > 0 && (
        <>
          <div className="section-h">Stalking — livable, hour not clean</div>
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
          Nothing locked. A tracked wallet has to buy, then the omo gate has to pass — buyers on the hour, livable MC, real 1h volume, pool deep enough. ~$2k MC names are refused as already rugged.
        </div>
      )}
      {(d?.open ?? []).map((t) => (
        <TradeCardRow key={t.id} t={t} onOpen={() => nav(`/p/${t.token_id}`)} />
      ))}
      <Pager page={d?.page ?? page} pages={d?.pages ?? 1} onPage={setPage} />

      {stream.length > 0 && (
        <>
          <div className="section-h">Live stream</div>
          <ol className="stream">
            {stream.slice(0, 16).map((s: StreamRow) => (
              <li key={s.id}>
                <span className="t">{timeAgo(s.at)}</span>
                <b className={`k-${s.action.toLowerCase()}`}>{s.action}</b>
                <span>{s.detail}</span>
              </li>
            ))}
          </ol>
        </>
      )}
      {wr != null && <p className="blurb">Paper hit rate {wr}% on ATH ≥ 2×.</p>}
    </div>
  );
}
