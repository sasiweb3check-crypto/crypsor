import { useMemo, useState, type CSSProperties } from "react";
import { useLocation } from "wouter";
import {
  api, fmtPct, fmtUsd, timeAgo, type Phase, type PatientCard, type WardBoard, PHASE_META,
} from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";

const FILTERS: Array<{ id: string; label: string }> = [
  { id: "live", label: "Live" },
  { id: "icu", label: "ICU" },
  { id: "intake", label: "Intake" },
  { id: "ward", label: "Ward" },
  { id: "recovery", label: "Recovery" },
  { id: "revived", label: "Revived" },
  { id: "deceased", label: "Deceased" },
];

function Score({ n, phase }: { n: number | null; phase: Phase }) {
  const p = Math.max(0, Math.min(100, n ?? 0));
  const ring = phase === "icu" || phase === "deceased" ? "var(--coral)"
    : phase === "revived" ? "var(--violet)"
      : phase === "intake" ? "var(--gold)"
        : "var(--sage)";
  return (
    <div className="score-ring" style={{ "--p": p, "--ring": ring } as CSSProperties}>
      <span>{n ?? "—"}</span>
    </div>
  );
}

function Card({ p, onOpen }: { p: PatientCard; onOpen: () => void }) {
  const x = p.admission_mc && p.last_mc && p.admission_mc > 0 ? p.last_mc / p.admission_mc : null;
  const reason = p.last_reasons?.fails?.[0] || p.last_reasons?.holds?.[0] || p.last_verdict || "awaiting vitals";
  return (
    <button type="button" className="card" onClick={onOpen}>
      {p.image
        ? <img src={p.image} alt="" className="thumb" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        : <span className="thumb blank" />}
      <div className="card-main">
        <div className="sym">
          ${p.symbol || p.name || p.mint.slice(0, 6)}{" "}
          <span className={`badge phase-${p.phase}`}>{PHASE_META[p.phase]?.label ?? p.phase}</span>
        </div>
        <div className="meta">
          {fmtUsd(p.last_mc)} · {p.wallet_buys} wallet{p.wallet_buys === 1 ? "" : "s"}
          {x != null ? ` · ${x.toFixed(1)}×` : ""} · {timeAgo(p.last_scan_at || p.discovered_at)}
        </div>
        <div className="meta">{reason}</div>
      </div>
      <Score n={p.survival_score} phase={p.phase} />
    </button>
  );
}

export default function WardPage() {
  const [, nav] = useLocation();
  const [phase, setPhase] = useState("live");
  const [q, setQ] = useState("");
  const { connected, tick } = useSse(["patient:admit", "vitals:tick", "alert:new"]);
  const board = usePoll<WardBoard>(
    () => api(`api/ward?phase=${phase}&q=${encodeURIComponent(q)}`),
    connected ? 20_000 : 10_000,
    [phase, q, tick],
  );

  const d = board.data;
  const survival = useMemo(
    () => d?.stats.survival != null ? fmtPct(d.stats.survival * 100, 0) : "—",
    [d],
  );

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Crypsor <span>Ward</span></div>
        <div className={`live-dot ${connected ? "on" : ""}`} title={connected ? "live" : "polling"} />
      </header>

      <p className="blurb">
        Tokens bought by your wallets are patients. Survival is scored from tape leadership,
        liquidity, holder behaviour, and quality — not from public pump feeds.
      </p>

      <div className="stats">
        <div className="stat">
          <div className="stat-val">{d?.stats.live ?? 0}</div>
          <div className="stat-label">Live patients</div>
        </div>
        <div className="stat">
          <div className="stat-val" style={{ color: "var(--sage)" }}>{survival}</div>
          <div className="stat-label">Survival</div>
        </div>
        <div className="stat">
          <div className="stat-val">{d?.stats.avgScore != null ? Math.round(d.stats.avgScore) : "—"}</div>
          <div className="stat-label">Avg score</div>
        </div>
        <div className="stat">
          <div className="stat-val" style={{ color: "var(--gold)" }}>{d?.stats.trades24h ?? 0}</div>
          <div className="stat-label">Trades 24h</div>
        </div>
      </div>

      <div className="chips" role="tablist">
        {FILTERS.map((f) => {
          const n = f.id === "live" ? d?.stats.live : d?.census[f.id];
          return (
            <button
              key={f.id}
              type="button"
              className={phase === f.id ? "chip on" : "chip"}
              onClick={() => setPhase(f.id)}
            >
              {f.label}{n != null ? <span className="n">{n}</span> : null}
            </button>
          );
        })}
      </div>

      <div className="search">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search ticker or mint"
          autoCapitalize="off"
          autoCorrect="off"
        />
      </div>

      {board.loading && !d && <div className="empty">Reading the ward…</div>}
      {board.error && <div className="empty err">{board.error}</div>}
      {!board.loading && (d?.patients.length ?? 0) === 0 && !board.error && (
        <div className="empty">
          No patients yet. Add wallets in Settings — every buy is an admission.
        </div>
      )}
      {(d?.patients ?? []).map((p) => (
        <Card key={p.id} p={p} onOpen={() => nav(`/p/${p.id}`)} />
      ))}
    </div>
  );
}
