import {
  fmtUsd, fmtGainPct, fmtPassAt,
  type PassCard as Pass,
} from "../lib/api";

export function Gain({ pct, className = "mult" }: { pct: number | null; className?: string }) {
  const up = pct != null && pct >= 0;
  return <span className={`${className} ${pct == null ? "" : up ? "up" : "down"}`}>{fmtGainPct(pct)}</span>;
}

function momClass(m: Pass["momentum"]): string {
  if (m === "up") return "up";
  if (m === "down") return "down";
  return "";
}

export function PassRow({
  p, onOpen, compact = false,
}: {
  p: Pass;
  onOpen: () => void;
  compact?: boolean;
}) {
  const lane = p.lane === "dead" ? "dead" : p.lane === "archived" ? "archived" : p.status === "trim" ? "trim" : "live";
  const surv = p.survival;
  return (
    <button type="button" className={`trade rich ${lane}`} onClick={onOpen}>
      {p.image
        ? <img src={p.image} alt="" className="thumb lg" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        : <span className="thumb lg blank" />}
      <div className="card-main">
        <div className="sym">
          ${p.symbol || p.name || p.mint.slice(0, 6)}
          <span className={`st ${lane}`}>{lane}</span>
          {p.band && <span className="st band">{p.band}</span>}
          {p.momentum && p.momentum !== "unread" && (
            <span className={`st mom ${momClass(p.momentum)}`}>{p.momentum}</span>
          )}
        </div>
        <div className="meta">
          passed {fmtPassAt(p.passed_at)} · {fmtUsd(p.pass_mc)}
        </div>
        {!compact && (
          <div className="pass-now">
            now {fmtUsd(p.last_mc)} · ATH <Gain pct={p.ath_pct} className="inline-gain" />
            {surv != null && <> · surv {Math.round(surv)}</>}
          </div>
        )}
        {!compact && p.story && <p className="story-clip">{p.story}</p>}
        {surv != null && (
          <div className="surv-bar" aria-hidden>
            <i style={{ width: `${Math.max(4, Math.min(100, surv))}%` }} />
          </div>
        )}
      </div>
      <div className="pass-side">
        <Gain pct={p.gain_pct} />
        {compact && <em>ATH {fmtGainPct(p.ath_pct)}</em>}
      </div>
    </button>
  );
}

export function PerformerCard({ p, onOpen }: { p: Pass; onOpen: () => void }) {
  return (
    <button type="button" className="performer-card" onClick={onOpen}>
      {p.image
        ? <img src={p.image} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        : <span className="thumb lg blank" />}
      <b>${p.symbol || p.mint.slice(0, 4)}</b>
      <Gain pct={p.ath_pct} className="inline-gain" />
      <em>{p.momentum && p.momentum !== "unread" ? p.momentum : "ATH"}</em>
    </button>
  );
}
