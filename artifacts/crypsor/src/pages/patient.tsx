import { useRoute, useLocation } from "wouter";
import {
  api, fmtUsd, fmtSignedX, timeAgo, shortMint, shortWallet, gmgnUrl,
  type PatientChart, type TapeWindow, type TradeCard, type SnapshotRow, type AgentVote,
} from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";

function Spark({ points, admit }: { points: Array<{ t: number; v: number }>; admit: number | null }) {
  if (points.length < 2) return <div className="empty">Chart warming.</div>;
  const W = 640;
  const H = 160;
  const P = 10;
  const vs = points.map((p) => p.v);
  const min = Math.min(...vs, admit ?? Infinity);
  const max = Math.max(...vs, admit ?? 0);
  const range = max - min || 1;
  const x = (i: number) => P + (i / (points.length - 1)) * (W - P * 2);
  const y = (v: number) => H - P - ((v - min) / range) * (H - P * 2);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const up = vs[vs.length - 1] >= vs[0];
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {admit != null && (
        <line x1={P} x2={W - P} y1={y(admit)} y2={y(admit)} className="spark-alert" strokeDasharray="5 5" />
      )}
      <path d={d} className={up ? "spark-line" : "spark-line down"} />
    </svg>
  );
}

function TapeBlock({ label, w }: { label: string; w?: TapeWindow | null }) {
  const ch = w?.changePct;
  return (
    <div className="vit">
      <b>{w?.buys ?? "—"}/{w?.sells ?? "—"}</b>
      <span>{label}{ch != null ? ` ${ch >= 0 ? "+" : ""}${ch.toFixed(0)}%` : ""}</span>
    </div>
  );
}

function slopeLabel(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const pct = v * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`;
}

function SnapBox({ title, s }: { title: string; s?: SnapshotRow | null }) {
  const incomplete = Boolean(s?.incomplete) || (s?.filled && Object.values(s.filled).some((v) => v && v !== "live"));
  return (
    <div className={`snap-box ${incomplete ? "incomplete" : ""}`}>
      <b>{title}{incomplete ? <span className="gap">incomplete</span> : null}</b>
      {s ? (
        <>
          <em>{fmtUsd(s.mc_usd)}</em>
          <p>
            MC {s.filled?.mc === "live" ? slopeLabel(s.mc_slope) : "unread"}
            {" · "}liq {s.filled?.liq === "live" ? slopeLabel(s.liq_slope) : "unread"}
            {" · "}hold {s.filled?.holders === "live" ? slopeLabel(s.holder_slope) : "unread"}
            {s.tape_lead ? ` · ${s.tape_lead}` : ""}
          </p>
        </>
      ) : <p>Waiting for this series.</p>}
    </div>
  );
}

export default function PatientPage() {
  const [, params] = useRoute("/p/:id");
  const [, nav] = useLocation();
  const id = parseInt(params?.id ?? "0", 10);
  const { connected, tick } = useSse();
  const q = usePoll<PatientChart>(
    () => api(`api/patient/${id}`),
    connected ? 45_000 : 10_000,
    [id, tick],
  );

  const d = q.data;
  if (!d) {
    return (
      <div className="page">
        <header className="topbar">
          <button type="button" className="back" onClick={() => nav("/")}>← Desk</button>
        </header>
        {q.error ? <div className="empty err">{q.error}</div> : <div className="skel" />}
      </div>
    );
  }

  const t = d.token;
  const trade: TradeCard | null = d.trade ?? null;
  const last = d.lastScan;
  const spark = d.scans
    .filter((s) => s.mc_usd != null && s.mc_usd > 0)
    .map((s) => ({ t: new Date(s.at).getTime(), v: s.mc_usd! }));
  const entry = trade?.entry_mc ?? t.admission_mc;
  const gain = trade?.gain_x ?? t.xFromAdmit;
  const ath = trade?.ath_x ?? t.peakX;
  const votes = (d.watch?.votes ?? []) as AgentVote[];

  const copyMint = () => {
    void navigator.clipboard?.writeText(t.mint);
  };

  return (
    <div className="page">
      <header className="topbar">
        <button type="button" className="back" onClick={() => nav("/")}>← Desk</button>
        <div className={`live-dot ${connected ? "on" : ""}`} />
      </header>

      <div className="hero">
        {t.image && (
          <img src={t.image} alt="" className="thumb" style={{ width: 64, height: 64, borderRadius: 20 }} />
        )}
        <div className="hero-copy">
          <h1>${t.symbol || t.name || shortMint(t.mint)}</h1>
          <div className="mint">
            {t.mint}
            <button type="button" className="copy-btn" onClick={copyMint}>Copy</button>
          </div>
          <div className="hero-cta">
            <a className="cta-gmgn" href={gmgnUrl(t.mint)} target="_blank" rel="noreferrer">Open GMGN</a>
            <a className="link" href={`https://dexscreener.com/solana/${t.mint}`} target="_blank" rel="noreferrer">DexScreener</a>
            <a className="link" href={`https://pump.fun/coin/${t.mint}`} target="_blank" rel="noreferrer">pump.fun</a>
            <button type="button" className="link" onClick={() => nav("/alerts")}>Book</button>
          </div>
        </div>
      </div>

      {(d.narrative || d.pulse?.narrative) && (
        <div className="story">
          <div className="k">How we read this</div>
          <p>{d.narrative || d.pulse?.narrative || d.confirm?.narrative}</p>
          {(d.memory?.caution?.notes?.length ?? 0) > 0 && (
            <ul className="memory-notes">
              {(d.memory!.caution!.notes ?? []).slice(-6).reverse().map((n, i) => (
                <li key={`${i}-${n.slice(0, 24)}`}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="stat">
        <div className={`big-score ${(gain ?? 1) >= 1 ? "" : "down"}`}>
          {fmtSignedX(gain)}
          <small>
            {trade ? `vs lock ${fmtUsd(trade.entry_mc)} · ATH ${fmtSignedX(ath)}` : d.watch ? "on watchlist — not locked" : "watching — not locked"}
          </small>
        </div>
      </div>

      {trade?.exit_title && (
        <div className={`alert kind-${trade.exit_action === "exit" ? "act" : trade.exit_action === "trim" ? "watch" : "info"}`}>
          <div className="k">{trade.exit_action ?? "hold"}{trade.exit_take_pct ? ` · ${trade.exit_take_pct}%` : ""}</div>
          <h3>{trade.exit_title}</h3>
          {trade.exit_body && <p>{trade.exit_body}</p>}
        </div>
      )}

      {d.watch && !trade && (
        <div className="alert kind-watch">
          <div className="k">debate · {d.watch.yes_votes} yes / {d.watch.no_votes} no / {d.watch.hold_votes} hold</div>
          <h3>{d.watch.headline || "Agents have not agreed on this entry"}</h3>
          <p>{d.watch.entry_ok ? "Entry zone is acceptable." : "Entry is not satisfying yet — stays on watch."}</p>
          <div className="votes">
            {votes.map((v) => (
              <span key={v.agent} className={`vote ${v.vote}`} title={v.reason}>{v.agent} {v.vote}</span>
            ))}
          </div>
        </div>
      )}

      <div className="grid3">
        <div className="vit"><b>{fmtUsd(t.last_mc)}</b><span>Now</span></div>
        <div className="vit"><b>{fmtUsd(entry)}</b><span>{trade ? "Lock" : "Admit"}</span></div>
        <div className="vit"><b>{fmtUsd(trade?.peak_mc ?? t.peak_mc)}</b><span>ATH</span></div>
        <div className="vit"><b>{fmtUsd(t.last_liq)}</b><span>Liquidity</span></div>
        <div className="vit"><b>{t.last_holders ?? "—"}</b><span>Holders</span></div>
        <div className="vit"><b>{t.wallet_buys}</b><span>Wallets</span></div>
      </div>

      <div className="section-h">Tape</div>
      <div className="grid3">
        <TapeBlock label="5m" w={last?.tape?.m5 ?? { buys: last?.buys_5m ?? null, sells: last?.sells_5m ?? null, volUsd: last?.vol_5m ?? null, changePct: null }} />
        <TapeBlock label="1h" w={last?.tape?.h1} />
        <TapeBlock label="6h" w={last?.tape?.h6} />
      </div>

      <div className="section-h">Snapshots · pulse 2m / confirm 5m</div>
      <div className="snap-pair">
        <SnapBox title="Pulse · 2m" s={d.pulse} />
        <SnapBox title="Confirm · 5m" s={d.confirm} />
      </div>

      <div className="section-h">{trade ? "Since lock" : "Market cap"}</div>
      <Spark points={spark} admit={entry ?? null} />

      {(d.suggestions ?? []).length > 0 && (
        <>
          <div className="section-h">Suggestions</div>
          {(d.suggestions ?? []).slice(0, 3).map((s) => (
            <div key={s.id} className={`alert kind-${s.severity}`}>
              <div className="k">{s.severity}</div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </>
      )}

      <div className="section-h">Wallets</div>
      <div className="list">
        {d.admissions.length === 0 && <div className="row"><span className="blurb">No wallet rows yet</span></div>}
        {d.admissions.map((a) => (
          <div key={`${a.wallet}-${a.at}`} className="row">
            <span>{a.label || shortWallet(a.wallet)}</span>
            <span className="blurb">{timeAgo(a.at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
