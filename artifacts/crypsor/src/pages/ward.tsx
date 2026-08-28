import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { api, fmtGainPct, timeAgo, type LiveBoard, type PassCard } from "../lib/api";
import { useLiveBoard } from "../hooks/use-data";
import { PassRow, PerformerCard } from "../components/pass-card";

const PAGE = 8;
const MC = ["all", "low", "mid", "mega"] as const;
const MOM = ["all", "up", "flat", "down"] as const;

function matches(p: PassCard, mc: string, mom: string): boolean {
  if (mc !== "all" && p.band !== mc) return false;
  if (mom !== "all" && p.momentum !== mom) return false;
  return true;
}

export default function WardPage() {
  const [, nav] = useLocation();
  const board = useLiveBoard<LiveBoard>(() => api("api/stats"));
  const [mc, setMc] = useState<(typeof MC)[number]>("all");
  const [mom, setMom] = useState<(typeof MOM)[number]>("all");
  const [shown, setShown] = useState(PAGE);
  const d = board.data;
  const live = useMemo(
    () => (d?.live ?? []).filter((p) => matches(p, mc, mom)),
    [d?.live, mc, mom],
  );
  const page = live.slice(0, shown);
  const performers = d?.performers ?? [];
  const today = d?.days[0];

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Crypsor <span>Desk</span></div>
        <div className="fresh">
          {board.connected ? "live" : "polling"}
          {d?.at ? ` · ${timeAgo(d.at)}` : ""}
        </div>
        <div className={`live-dot ${board.connected ? "on" : ""}`} />
      </header>

      <p className="blurb">
        Passed names only. Live prints keep rolling. 10m / 15m / 1h snapshots judge survival and momentum.
        Filters change the view, not the book. Everything else stays in logs.
      </p>

      <div className="stats">
        <div className="stat">
          <div className="stat-val">{d?.census?.tokens ?? d?.totals.tokens ?? 0}</div>
          <div className="stat-label">Tokens</div>
        </div>
        <div className="stat">
          <div className="stat-val" style={{ color: "var(--sage)" }}>{d?.census?.passed ?? d?.totals.passed ?? 0}</div>
          <div className="stat-label">Passed</div>
        </div>
        <div className="stat">
          <div className="stat-val">{d?.totals.live ?? 0}</div>
          <div className="stat-label">Live</div>
        </div>
        <div className="stat">
          <div className="stat-val" style={{ color: "var(--gold)" }}>
            {d?.totals.avgSurvival != null ? Math.round(d.totals.avgSurvival) : "—"}
          </div>
          <div className="stat-label">Avg survival</div>
        </div>
      </div>

      {performers.length > 0 && (
        <>
          <div className="section-h">Performers</div>
          <div className="performer-row">
            {performers.map((p) => (
              <PerformerCard key={p.token_id} p={p} onOpen={() => nav(`/p/${p.token_id}`)} />
            ))}
          </div>
        </>
      )}

      <div className="chips" role="tablist" aria-label="Market cap">
        {MC.map((k) => (
          <button
            key={k}
            type="button"
            className={mc === k ? "chip on" : "chip"}
            onClick={() => { setMc(k); setShown(PAGE); }}
          >
            {k === "all" ? "All MC" : k}
          </button>
        ))}
      </div>
      <div className="chips" role="tablist" aria-label="Momentum">
        {MOM.map((k) => (
          <button
            key={k}
            type="button"
            className={mom === k ? "chip on" : "chip"}
            onClick={() => { setMom(k); setShown(PAGE); }}
          >
            {k === "all" ? "All tape" : k}
          </button>
        ))}
      </div>

      {(d?.days.length ?? 0) > 0 && (
        <div className="days-strip" role="list">
          {(d?.days ?? []).slice(0, 8).map((day) => (
            <button
              key={day.day}
              type="button"
              className={`day-chip${today?.day === day.day ? " on" : ""}`}
              onClick={() => nav(`/alerts?day=${day.day}`)}
            >
              <b>{day.passed}</b>
              <span>{day.day.slice(5)}</span>
              <em>{fmtGainPct(day.avgAthPct)}</em>
            </button>
          ))}
        </div>
      )}

      <div className="section-h">Live passes</div>
      {board.loading && !d && (
        <>
          <div className="skel" /><div className="skel" /><div className="skel" />
        </>
      )}
      {board.error && <div className="empty err">{board.error}</div>}
      {!board.loading && live.length === 0 && !board.error && (
        <div className="empty">
          No live pass in this filter. A tracked wallet has to swap into a name, Dex or pump.fun has to confirm it, then the gate has to clear.
        </div>
      )}
      {page.map((p) => (
        <PassRow key={p.token_id} p={p} onOpen={() => nav(`/p/${p.token_id}`)} />
      ))}
      {shown < live.length && (
        <button type="button" className="more" onClick={() => setShown((n) => n + PAGE)}>
          Show more · {live.length - shown} left
        </button>
      )}

      {(d?.archived.length ?? 0) > 0 && (
        <>
          <div className="section-h">Archived · random momentum</div>
          {d!.archived.filter((p) => matches(p, mc, mom)).slice(0, 6).map((p) => (
            <PassRow key={p.token_id} p={p} compact onOpen={() => nav(`/p/${p.token_id}`)} />
          ))}
        </>
      )}
    </div>
  );
}
