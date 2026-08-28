import { useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import {
  api, fmtGainPct, fmtDay, fmtHitRate, type StatsReport, type DayPasses, type PassCard,
} from "../lib/api";
import { usePoll } from "../hooks/use-data";
import { PassRow } from "../components/pass-card";

function dayFromSearch(search: string): string {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const day = q.get("day") ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
}

function HitCard({
  label, hits, called, rate,
}: {
  label: string; hits: number; called: number; rate: number | null;
}) {
  return (
    <div className="stat">
      <div className="stat-val">{fmtHitRate(rate)}</div>
      <div className="stat-label">{label}</div>
      <div className="stat-sub">{hits} / {called} called</div>
    </div>
  );
}

export default function StatsPage() {
  const [, nav] = useLocation();
  const search = useSearch();
  const picked = dayFromSearch(search);
  const [lane, setLane] = useState<"all" | "24h" | "archived" | "dead">("all");
  const report = usePoll<StatsReport>(() => api("api/stats/report"), 8_000, []);
  const dayQ = usePoll<DayPasses>(
    () => picked
      ? api(`api/stats?day=${picked}`)
      : Promise.resolve({ day: "", passes: [], at: "" }),
    picked ? 12_000 : 86_400_000,
    [picked],
  );
  const d = report.data;
  const days = d?.days ?? [];

  const cards: PassCard[] = useMemo(() => {
    if (picked && dayQ.data?.day === picked) return dayQ.data.passes;
    if (lane === "24h") return d?.recent24h ?? [];
    return d?.recent ?? [];
  }, [picked, dayQ.data, d, lane]);

  const shown = cards.filter((p) => {
    if (lane === "all" || lane === "24h") return true;
    return p.lane === lane;
  });

  const heading = picked
    ? fmtDay(picked)
    : lane === "24h"
      ? "Calls in the last 24 hours"
      : "Recent calls";

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Crypsor <span>Stats</span></div>
        <div className={`live-dot ${!report.error ? "on" : ""}`} />
      </header>
      <p className="blurb">
        Called names since the fresh count. Hit rates are ATH vs the printed entry — 2×, 5×, 10×.
      </p>

      {report.loading && !d ? <div className="skel" /> : null}
      {report.error ? <div className="empty err">{report.error}</div> : null}

      {d ? (
        <>
          <div className="stats hit">
            <div className="stat">
              <div className="stat-val">{d.called}</div>
              <div className="stat-label">Called</div>
              <div className="stat-sub">{d.live} live · {d.archived} archived</div>
            </div>
            <HitCard label="2× hit" hits={d.hit2x} called={d.called} rate={d.rate2x} />
            <HitCard label="5× hit" hits={d.hit5x} called={d.called} rate={d.rate5x} />
            <HitCard label="10× hit" hits={d.hit10x} called={d.called} rate={d.rate10x} />
          </div>
          <div className="stats">
            <div className="stat">
              <div className="stat-val">{d.called24h}</div>
              <div className="stat-label">24h calls</div>
              <div className="stat-sub">printed in the last day</div>
            </div>
            <div className="stat">
              <div className="stat-val">{fmtGainPct(d.avgAthPct)}</div>
              <div className="stat-label">Avg ATH</div>
              <div className="stat-sub">vs entry</div>
            </div>
            <div className="stat">
              <div className="stat-val">{fmtGainPct(d.avgGainPct)}</div>
              <div className="stat-label">Avg gain</div>
              <div className="stat-sub">now vs entry</div>
            </div>
            <div className="stat">
              <div className="stat-val">{fmtGainPct(d.bestAthPct)}</div>
              <div className="stat-label">Best ATH</div>
              <div className="stat-sub">{d.dead} dead</div>
            </div>
          </div>
        </>
      ) : null}

      <div className="days-strip" role="list">
        <button
          type="button"
          className={`day-chip${!picked ? " on" : ""}`}
          onClick={() => nav("/stats")}
        >
          <b>{d?.called ?? 0}</b>
          <span>all</span>
          <em>{fmtGainPct(d?.avgAthPct ?? null)}</em>
        </button>
        {days.map((day) => (
          <button
            key={day.day}
            type="button"
            className={`day-chip${picked === day.day ? " on" : ""}`}
            onClick={() => nav(`/stats?day=${day.day}`)}
          >
            <b>{day.passed}</b>
            <span>{day.day.slice(5)}</span>
            <em>{fmtGainPct(day.avgAthPct)}</em>
          </button>
        ))}
      </div>

      {picked && days.find((x) => x.day === picked) ? (
        <div className="stats">
          {(["passed", "hit2x", "hit5x", "hit10x"] as const).map((k) => {
            const row = days.find((x) => x.day === picked)!;
            const val = k === "passed" ? row.passed : k === "hit2x" ? row.hit2x : k === "hit5x" ? (row.hit5x ?? 0) : (row.hit10x ?? 0);
            return (
              <div key={k} className="stat">
                <div className="stat-val">{val}</div>
                <div className="stat-label">{k === "passed" ? "called" : k.replace("hit", "")}</div>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="chips">
        {(["all", "24h", "archived", "dead"] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={lane === k ? "chip on" : "chip"}
            onClick={() => {
              setLane(k);
              if (k === "24h" && picked) nav("/stats");
            }}
          >
            {k === "24h" ? "24h" : k}
          </button>
        ))}
      </div>

      <div className="section-h">{heading}</div>
      {shown.length === 0 && !report.loading && !report.error ? (
        <div className="empty">No calls in this slice yet.</div>
      ) : null}
      {shown.map((p) => (
        <PassRow key={p.id} p={p} onOpen={() => nav(`/p/${p.token_id}`)} />
      ))}
    </div>
  );
}
