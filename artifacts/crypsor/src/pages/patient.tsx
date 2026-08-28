import { useRoute, useLocation } from "wouter";
import {
  api, fmtUsd, fmtGainPct, fmtPassAt, fmtSignedX, timeAgo, shortMint, shortWallet, gmgnUrl,
  type PatientChart, type TapeWindow, type TradeCard, type Check, type DecisionReasons, type SnapshotRow,
} from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";
import { TokenImg, sourceLabel } from "../components/pass-card";

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

function kindLabel(kind?: string): string {
  if (kind === "pulse") return "10m";
  if (kind === "hour") return "1h";
  if (kind === "confirm") return "15m";
  return kind || "snap";
}

function SnapCard({ s }: { s: SnapshotRow }) {
  const slope = s.mc_slope;
  return (
    <div className={`snap-card ${s.incomplete ? "thin" : ""}`}>
      <div className="snap-top">
        <b>{kindLabel(s.kind)}</b>
        <em>{timeAgo(s.at)}</em>
      </div>
      <div className="snap-mc">{fmtUsd(s.mc_usd)}</div>
      <div className={`meta ${slope != null && slope >= 0 ? "up" : "down"}`}>
        {slope != null ? `${slope >= 0 ? "+" : ""}${(slope * 100).toFixed(1)}%` : "no slope"}
        {s.score != null ? ` · surv ${s.score}` : ""}
      </div>
      {s.narrative && <p className="story-clip">{s.narrative}</p>}
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
    connected ? 20_000 : 8_000,
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
  const reasons = (t.last_reasons ?? last?.tape ?? {}) as DecisionReasons;
  const checks: Check[] = reasons.checks
    ?? [
      ...(reasons.holds ?? []).map((text) => ({ text, hold: true as const })),
      ...(reasons.fails ?? []).map((text) => ({ text, hold: false as const })),
      ...(reasons.unknowns ?? []).map((text) => ({ text, hold: null })),
    ];
  const snaps = [...(d.snapshots ?? [])].reverse().slice(0, 12);
  const notes = d.memory?.caution && typeof d.memory.caution === "object"
    ? (d.memory.caution as { notes?: string[] }).notes ?? []
    : [];
  const story = d.narrative || reasons.thesis || t.last_suggestion || "";
  const socials = t.meta?.socials ?? [];
  const sentiment = t.meta?.sentiment ?? null;
  const publicTape = t.wallet_buys < 1 && t.source && t.source !== "wallet_buy";

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
        <TokenImg
          src={t.image}
          letter={t.symbol || t.name || t.mint}
          className="thumb lg hero-thumb"
        />
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
          </div>
        </div>
      </div>

      {story && (
        <div className="story">
          <div className="k">
            {trade ? "surviving" : publicTape ? "public tape" : "read"}
            {sentiment ? ` · ${sentiment}` : ""}
            {t.survival_score != null ? ` · ${t.survival_score}` : ""}
          </div>
          <p>{story}</p>
          {(t.source || socials.length > 0) && (
            <div className="meta" style={{ whiteSpace: "normal", marginTop: 10 }}>
              {t.source ? sourceLabel(t.source) : ""}
              {socials.length ? ` · ${socials.join(" · ")}` : ""}
              {publicTape ? " · suggestion only — not a pass" : ""}
            </div>
          )}
        </div>
      )}

      <div className="stat">
        <div className={`big-score ${(trade?.gain_pct ?? ((gain ?? 1) - 1) * 100) >= 0 ? "" : "down"}`}>
          {trade ? fmtGainPct(trade.gain_pct ?? ((gain ?? 1) - 1) * 100) : fmtSignedX(gain)}
          <small>
            {trade
              ? `passed ${fmtPassAt(trade.called_at)} at ${fmtUsd(trade.entry_mc)} · ATH vs entry ${fmtGainPct(trade.ath_pct ?? ((ath ?? 1) - 1) * 100)}`
              : publicTape
                ? "scanner can suggest — a pass still needs a tracked wallet"
                : "not a pass — refusals stay in logs"}
          </small>
        </div>
      </div>

      <div className="grid3">
        <div className="vit"><b>{fmtUsd(t.last_mc)}</b><span>Now</span></div>
        <div className="vit"><b>{fmtUsd(entry)}</b><span>{trade ? "At pass" : publicTape ? "Suggested" : "Admit"}</span></div>
        <div className="vit"><b>{t.survival_score ?? "—"}</b><span>Survival</span></div>
        <div className="vit"><b>{fmtUsd(t.last_liq)}</b><span>Liquidity</span></div>
        <div className="vit"><b>{t.last_holders ?? "—"}</b><span>Holders</span></div>
        <div className="vit"><b>{t.wallet_buys}</b><span>Wallets</span></div>
      </div>

      {snaps.length > 0 && (
        <>
          <div className="section-h">Snapshots · 10m / 15m / 1h</div>
          <div className="snap-list">
            {snaps.map((s) => (
              <SnapCard key={`${s.kind}-${s.at}`} s={s} />
            ))}
          </div>
        </>
      )}

      {notes.length > 0 && (
        <>
          <div className="section-h">Memory</div>
          <ol className="stream">
            {notes.slice().reverse().slice(0, 8).map((n, i) => (
              <li key={`${n}-${i}`}>
                <span className="t">note</span>
                <b className="k-read">MEM</b>
                <span>{n}</span>
              </li>
            ))}
          </ol>
        </>
      )}

      {trade?.exit_title && (
        <div className="alert kind-watch">
          <div className="k">note</div>
          <h3>{trade.exit_title}</h3>
          {trade.exit_body && <p>{trade.exit_body}</p>}
        </div>
      )}

      {checks.length > 0 && !trade && (
        <>
          <div className="section-h">Gate</div>
          <ul className="checks">
            {checks.map((c) => (
              <li key={c.text} className={c.hold === true ? "holds" : c.hold === false ? "fails" : "unread"}>
                {c.hold === true ? "holds" : c.hold === false ? "fails" : "unread"} — {c.text}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="section-h">Tape</div>
      <div className="grid3">
        <TapeBlock label="5m" w={last?.tape?.m5 ?? { buys: last?.buys_5m ?? null, sells: last?.sells_5m ?? null, volUsd: last?.vol_5m ?? null, changePct: null }} />
        <TapeBlock label="1h" w={last?.tape?.h1} />
        <TapeBlock label="6h" w={last?.tape?.h6} />
      </div>

      <div className="section-h">{trade ? "Since pass · vs entry" : "Market cap"}</div>
      <Spark points={spark} admit={entry ?? null} />

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
