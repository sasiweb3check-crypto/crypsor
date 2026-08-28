import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { api, fmtGainPct, timeAgo, type LiveBoard, type PassCard } from "../lib/api";
import { useLiveBoard } from "../hooks/use-data";
import { PassRow, PerformerCard, TapeRow } from "../components/pass-card";

const PAGE = 8;
const MC = ["all", "low", "mid", "mega"] as const;
const MOM = ["all", "up", "flat", "down"] as const;

function matches(p: PassCard, mc: string, mom: string): boolean {
  if (mc !== "all" && p.band !== mc) return false;
  if (mom !== "all" && p.momentum !== mom) return false;
  return true;
}

function Stat({
  value, label, color,
}: {
  value: string | number;
  label: string;
  color?: string;
}) {
  return (
    <div className="stat">
      <div className="stat-val" style={color ? { color } : undefined}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
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
  const suggestions = d?.suggestions ?? [];
  const waiting = d?.waiting ?? [];
  const today = d?.days[0];
  const tok = d?.tokenStats;
  const perf = d?.performance ?? d?.totals;
  const open = (id: number) => nav(`/p/${id}`);

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
        Public tape waits, then the scanner grades it. A suggestion is not a pass.
        Passes still need a tracked-wallet swap. ATH is vs the entry we printed.
      </p>

      <div className="stats-kicker">Token stats</div>
      <div className="stats">
        <Stat value={tok?.tokens ?? d?.census?.tokens ?? d?.totals.tokens ?? 0} label="Names" />
        <Stat value={tok?.waiting ?? d?.census?.waiting ?? waiting.length} label="Waiting" />
        <Stat
          value={tok?.suggestions ?? d?.census?.suggestions ?? suggestions.length}
          label="Suggestions"
          color="var(--gold)"
        />
        <Stat value={tok?.scanned24h ?? 0} label="Scanned 24h" />
      </div>

      <div className="stats-kicker">Performance · vs entry</div>
      <div className="stats">
        <Stat value={perf?.live ?? 0} label="Live" color="var(--sage)" />
        <Stat value={perf?.passed ?? d?.census?.passed ?? 0} label="Passed" />
        <Stat value={fmtGainPct(perf?.avgGainPct ?? null)} label="Avg gain" />
        <Stat value={fmtGainPct(perf?.avgAthPct ?? null)} label="ATH vs entry" color="var(--gold)" />
      </div>
      <div className="stats-sub">
        Survival {perf?.avgSurvival != null ? Math.round(perf.avgSurvival) : "—"}
        {" · "}
        2× hits {perf?.hit2x ?? 0}
      </div>

      {suggestions.length > 0 && (
        <>
          <div className="section-h">Suggestions · scanner buying, not locked</div>
          {suggestions.map((t) => (
            <TapeRow key={t.id} t={t} onOpen={() => open(t.id)} />
          ))}
        </>
      )}

      {waiting.length > 0 && (
        <>
          <div className="section-h">Waiting · Dex / pump.fun / CoinGecko</div>
          {waiting.map((t) => (
            <TapeRow key={t.id} t={t} waiting onOpen={() => open(t.id)} />
          ))}
        </>
      )}

      {performers.length > 0 && (
        <>
          <div className="section-h">Performers</div>
          <div className="performer-row">
            {performers.map((p) => (
              <PerformerCard key={p.token_id} p={p} onOpen={() => open(p.token_id)} />
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
          No live pass in this filter. Public tape can suggest. A pass still needs a tracked wallet swap that Dex or pump.fun confirms.
        </div>
      )}
      {page.map((p) => (
        <PassRow key={p.token_id} p={p} onOpen={() => open(p.token_id)} />
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
            <PassRow key={p.token_id} p={p} compact onOpen={() => open(p.token_id)} />
          ))}
        </>
      )}
    </div>
  );
}
