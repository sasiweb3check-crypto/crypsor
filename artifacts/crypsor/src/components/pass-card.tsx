import { useState } from "react";
import {
  fmtUsd, fmtGainPct, deskImg, gmgnUrl, timeAgo,
  type DeskLabel, type ScoreStat, type TokenCard,
} from "../lib/api";

export function TokenImg({
  src, mint, letter, className = "thumb",
}: {
  src: string | null | undefined;
  mint?: string | null;
  letter: string;
  className?: string;
}) {
  const urls = [deskImg(src, mint), mint ? deskImg(null, mint) : null]
    .filter((u, i, a): u is string => Boolean(u) && a.indexOf(u) === i);
  const [failed, setFailed] = useState<string[]>([]);
  const url = urls.find((u) => !failed.includes(u));
  const mark = (letter || "?").slice(0, 1).toUpperCase();
  if (!url) {
    return <span className={`${className} blank`} aria-hidden>{mark}</span>;
  }
  return (
    <img
      src={url}
      alt=""
      className={className}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed((prev) => (prev.includes(url) ? prev : [...prev, url]))}
    />
  );
}

function letterOf(p: { symbol?: string | null; name?: string | null; mint: string }): string {
  return p.symbol || p.name || p.mint;
}

export function Gain({ pct }: { pct: number | null }) {
  const up = pct != null && pct >= 0;
  return <span className={`gain ${pct == null ? "" : up ? "up" : "down"}`}>{fmtGainPct(pct)}</span>;
}

export function LabelChip({ label }: { label: DeskLabel | string | null | undefined }) {
  if (!label || label === "dead" || label === "watch" || label === "late" || label === "runner" || label === "call" || label === "heat") {
    return null;
  }
  return <span className={`lb ${label}`}>{label}</span>;
}

function RiskNote({ p }: { p: TokenCard }) {
  if (p.rug !== "dump" && p.rug !== "rug" && p.rug !== "caution") return null;
  const text = p.rug === "rug" ? "rug possible" : p.rug === "dump" ? "clean dump" : "caution";
  return <span className={`risk ${p.rug}`}>{text}</span>;
}

export function TokenRow({ p, onOpen }: { p: TokenCard; onOpen: () => void }) {
  return (
    <div className={`tok-card ${p.status}${p.rug === "dump" || p.rug === "rug" ? " warn" : ""}`}>
      <button type="button" className="thumb-hit" onClick={onOpen}>
        <TokenImg src={p.image} mint={p.mint} letter={letterOf(p)} className="thumb lg" />
      </button>
      <button type="button" className="card-main" onClick={onOpen}>
        <div className="sym">
          ${p.symbol || p.name || p.mint.slice(0, 6)}
          <span className="score-pip">{p.score ?? "—"}</span>
          <LabelChip label={p.label} />
          <RiskNote p={p} />
        </div>
        <div className="tok-grid">
          <span>now <b>{fmtUsd(p.last_mc)}</b></span>
          <span>gain <Gain pct={p.gain_pct} /></span>
          <span>ath <Gain pct={p.ath_pct} /></span>
          {p.entry_mc != null
            ? <span className="ok">entry <b>{fmtUsd(p.entry_mc)}</b></span>
            : <span className="muted">no entry</span>}
        </div>
      </button>
      <div className="side">
        <a
          className="gmgn-ic"
          href={gmgnUrl(p.mint)}
          target="_blank"
          rel="noreferrer"
          aria-label="GMGN"
          onClick={(e) => e.stopPropagation()}
        >
          G
        </a>
        {p.last_scan_at ? <span className="muted">{timeAgo(p.last_scan_at)}</span> : null}
      </div>
    </div>
  );
}

export function PerformerCard({ p, onOpen }: { p: TokenCard; onOpen: () => void }) {
  return (
    <div className="perf-card">
      <button type="button" className="perf-hit" onClick={onOpen}>
        <TokenImg src={p.image} mint={p.mint} letter={letterOf(p)} className="thumb lg" />
        <div className="perf-body">
          <div className="sym">
            ${p.symbol || p.mint.slice(0, 4)}
            <span className="score-pip">{p.score ?? "—"}</span>
          </div>
          <div className="tok-grid tight">
            <Gain pct={p.gain_pct} />
            <span className="muted">ath <Gain pct={p.ath_pct} /></span>
          </div>
          {p.entry_mc != null ? <div className="muted">entry {fmtUsd(p.entry_mc)}</div> : null}
          <RiskNote p={p} />
        </div>
      </button>
      <a
        className="gmgn-ic"
        href={gmgnUrl(p.mint)}
        target="_blank"
        rel="noreferrer"
        aria-label="GMGN"
      >
        G
      </a>
    </div>
  );
}

export function ScoreStrip({ stats }: { stats: ScoreStat[] }) {
  return (
    <section className="matrix" aria-label="Score ranges vs later 2x 5x">
      <div className="h">Frozen score vs later 2× / 5×</div>
      <div className="matrix-grid score-grid">
        {stats.map((s) => (
          <div key={s.bucket} className="num">
            <div className="k">Score {s.bucket}</div>
            <div className="v">{s.n ? `${s.pct2x.toFixed(0)}%` : "—"}</div>
            <div className="muted">{s.n} prints · 2× {s.hit2x} · 5× {s.hit5x}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** MC (green) + holders (blue) from oldest → newest snapshot. */
export function MemoryChart({
  points,
}: {
  points: Array<{ mc_usd: number | null; holders: number | null; rug?: string | null }>;
}) {
  const rows = [...points].reverse().filter((p) => p.mc_usd != null || p.holders != null);
  if (rows.length < 2) return null;
  const w = 320;
  const h = 88;
  const pad = 8;
  const mcs = rows.map((p) => p.mc_usd).filter((n): n is number => n != null);
  const holds = rows.map((p) => p.holders).filter((n): n is number => n != null);
  const line = (vals: number[]) => {
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    return vals.map((v, i) => {
      const x = pad + (i / Math.max(vals.length - 1, 1)) * (w - pad * 2);
      const y = h - pad - ((v - min) / span) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  };
  const warn = rows[rows.length - 1]?.rug === "dump" || rows[rows.length - 1]?.rug === "rug";
  return (
    <div className={`spark ${warn ? "warn" : ""}`} aria-label="MC and holders across snapshots">
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img">
        {mcs.length >= 2 ? <polyline fill="none" stroke={warn ? "#e85d5d" : "#3dd68c"} strokeWidth="2" points={line(mcs)} /> : null}
        {holds.length >= 2 ? <polyline fill="none" stroke="#6ea8ff" strokeWidth="1.5" points={line(holds)} opacity="0.85" /> : null}
      </svg>
      <div className="muted spark-k">green MC · blue holders{warn ? " · dump vs last prints" : ""}</div>
    </div>
  );
}
