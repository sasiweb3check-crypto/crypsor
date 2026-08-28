import {
  fmtUsd, fmtGainPct, fmtPassAt,
  type PassCard as Pass,
} from "../lib/api";

export function Gain({ pct, className = "mult" }: { pct: number | null; className?: string }) {
  const up = pct != null && pct >= 0;
  return <span className={`${className} ${pct == null ? "" : up ? "up" : "down"}`}>{fmtGainPct(pct)}</span>;
}

export function PassRow({
  p, onOpen, compact = false,
}: {
  p: Pass;
  onOpen: () => void;
  compact?: boolean;
}) {
  const lane = p.lane === "dead" ? "dead" : p.lane === "archived" ? "archived" : p.status === "trim" ? "trim" : "live";
  return (
    <button type="button" className={`trade ${lane}`} onClick={onOpen}>
      {p.image
        ? <img src={p.image} alt="" className="thumb" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        : <span className="thumb blank" />}
      <div className="card-main">
        <div className="sym">
          ${p.symbol || p.name || p.mint.slice(0, 6)}
          <span className={`st ${lane}`}>{lane}</span>
        </div>
        <div className="meta">
          passed {fmtPassAt(p.passed_at)} · {fmtUsd(p.pass_mc)}
        </div>
        {!compact && (
          <div className="pass-now">
            now {fmtUsd(p.last_mc)} · ATH <Gain pct={p.ath_pct} className="inline-gain" />
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
