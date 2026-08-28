import { useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import {
  api, fmtGainPct, fmtDay, type LiveBoard, type DayPasses, type PassCard,
} from "../lib/api";
import { useLiveBoard, usePoll } from "../hooks/use-data";
import { PassRow } from "../components/pass-card";

function dayFromSearch(search: string): string {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const day = q.get("day") ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
}

export default function AlertsPage() {
  const [, nav] = useLocation();
  const search = useSearch();
  const picked = dayFromSearch(search);
  const [lane, setLane] = useState<"all" | "archived" | "dead">("all");
  const board = useLiveBoard<LiveBoard>(() => api("api/stats"));
  const dayQ = usePoll<DayPasses>(
    () => picked
      ? api(`api/stats?day=${picked}`)
      : Promise.resolve({ day: "", passes: [], at: "" }),
    picked ? 12_000 : 86_400_000,
    [picked],
  );
  const d = board.data;
  const days = d?.days ?? [];

  const cards: PassCard[] = useMemo(() => {
    if (picked && dayQ.data?.day === picked) return dayQ.data.passes;
    return [...(d?.live ?? []), ...(d?.archived ?? [])];
  }, [picked, dayQ.data, d]);

  const shown = cards.filter((p) => {
    if (lane === "all") return true;
    return p.lane === lane;
  });
  const heading = picked ? fmtDay(picked) : "All recent passes";

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Days</div>
        <div className={`live-dot ${board.connected ? "on" : ""}`} />
      </header>
      <p className="blurb">
        Every pass since the fresh count, by day. Frozen MC at the pass, then gain and ATH vs that entry.
      </p>

      <div className="days-strip" role="list">
        <button
          type="button"
          className={`day-chip${!picked ? " on" : ""}`}
          onClick={() => nav("/alerts")}
        >
          <b>{d?.totals.passed ?? 0}</b>
          <span>all</span>
          <em>{fmtGainPct(d?.totals.avgAthPct ?? null)}</em>
        </button>
        {days.map((day) => (
          <button
            key={day.day}
            type="button"
            className={`day-chip${picked === day.day ? " on" : ""}`}
            onClick={() => nav(`/alerts?day=${day.day}`)}
          >
            <b>{day.passed}</b>
            <span>{day.day.slice(5)}</span>
            <em>{fmtGainPct(day.avgAthPct)}</em>
          </button>
        ))}
      </div>

      {picked && days.find((x) => x.day === picked) && (
        <div className="stats">
          {(["passed", "live", "archived", "dead"] as const).map((k) => {
            const row = days.find((x) => x.day === picked)!;
            return (
              <div key={k} className="stat">
                <div className="stat-val">{row[k]}</div>
                <div className="stat-label">{k}</div>
              </div>
            );
          })}
        </div>
      )}

      <div className="chips">
        {(["all", "archived", "dead"] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={lane === k ? "chip on" : "chip"}
            onClick={() => setLane(k)}
          >
            {k}
          </button>
        ))}
      </div>

      <div className="section-h">{heading}</div>
      {board.loading && !d && <div className="skel" />}
      {board.error && <div className="empty err">{board.error}</div>}
      {shown.length === 0 && !board.loading && !board.error && (
        <div className="empty">No passes in this slice yet.</div>
      )}
      {shown.map((p) => (
        <PassRow key={p.id} p={p} onOpen={() => nav(`/p/${p.token_id}`)} />
      ))}
    </div>
  );
}
