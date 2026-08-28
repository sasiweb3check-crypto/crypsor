import { useLocation } from "wouter";
import { api, fmtGainPct, timeAgo, type LiveBoard } from "../lib/api";
import { useLiveBoard } from "../hooks/use-data";
import { PassRow } from "../components/pass-card";

export default function WardPage() {
  const [, nav] = useLocation();
  const board = useLiveBoard<LiveBoard>(() => api("api/stats"));
  const d = board.data;
  const live = d?.live ?? [];
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
        Passes only. Time at the pass, market cap then, live print now, gain since, ATH gain.
        Refusals stay in logs. Dead names get a random momentum check, not a constant rescan.
      </p>

      <div className="stats">
        <div className="stat">
          <div className="stat-val">{d?.totals.live ?? 0}</div>
          <div className="stat-label">Live</div>
        </div>
        <div className="stat">
          <div className="stat-val" style={{ color: "var(--sage)" }}>{d?.totals.hit2x ?? 0}</div>
          <div className="stat-label">Hit 2×</div>
        </div>
        <div className="stat">
          <div className="stat-val">{fmtGainPct(d?.totals.avgGainPct ?? null)}</div>
          <div className="stat-label">Avg gain</div>
        </div>
        <div className="stat">
          <div className="stat-val" style={{ color: "var(--gold)" }}>{fmtGainPct(d?.totals.avgAthPct ?? null)}</div>
          <div className="stat-label">Avg ATH</div>
        </div>
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
          No live pass yet. A tracked wallet has to buy, then the gate has to clear — buyers on the hour, livable MC, real 1h volume. Names around $2k MC are refused as already rugged.
        </div>
      )}
      {live.map((p) => (
        <PassRow key={p.id} p={p} onOpen={() => nav(`/p/${p.token_id}`)} />
      ))}

      {(d?.archived.length ?? 0) > 0 && (
        <>
          <div className="section-h">Archived · random momentum</div>
          {d!.archived.slice(0, 6).map((p) => (
            <PassRow key={p.id} p={p} compact onOpen={() => nav(`/p/${p.token_id}`)} />
          ))}
        </>
      )}
    </div>
  );
}
