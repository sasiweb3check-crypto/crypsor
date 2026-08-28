import { useRoute, useLocation } from "wouter";
import {
  api, fmtPct, fmtUsd, fmtX, timeAgo, shortMint, shortWallet, PHASE_META,
  type PatientChart, type Factor, type Phase,
} from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";

function Spark({ points, admit }: { points: Array<{ t: number; v: number }>; admit: number | null }) {
  if (points.length < 2) return <div className="empty">Chart warming — waiting for vitals.</div>;
  const W = 640;
  const H = 140;
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

function Factors({ factors }: { factors: Factor[] }) {
  if (!factors.length) return <div className="empty">Factors appear after the first vitals scan.</div>;
  return (
    <>
      {factors.map((f) => {
        const cls = f.hold === false ? "fail" : f.hold == null ? "unk" : "";
        return (
          <div key={f.id} className="factor">
            <div className="factor-top">
              <span>{f.label}</span>
              <em>{Math.round(f.points)}/{f.max}</em>
            </div>
            <div className={`bar ${cls}`}><i style={{ width: `${Math.max(4, (f.points / f.max) * 100)}%` }} /></div>
            <p>{f.reason}</p>
          </div>
        );
      })}
    </>
  );
}

export default function PatientPage() {
  const [, params] = useRoute("/p/:id");
  const [, nav] = useLocation();
  const id = parseInt(params?.id ?? "0", 10);
  const { connected, tick } = useSse(["vitals:tick", "alert:new", "agent:note"]);
  const q = usePoll<PatientChart>(
    () => api(`api/patient/${id}`),
    connected ? 18_000 : 10_000,
    [id, tick],
  );

  const d = q.data;
  if (!d) {
    return (
      <div className="page">
        <header className="topbar">
          <button type="button" className="back" onClick={() => nav("/")}>← Ward</button>
        </header>
        <div className="empty">{q.error ?? "Opening chart…"}</div>
      </div>
    );
  }

  const t = d.token;
  const phase = (t.phase ?? "intake") as Phase;
  const factors: Factor[] = d.lastScan?.tape?.factors ?? [];
  const spark = d.scans
    .filter((s) => s.mc_usd != null && s.mc_usd > 0)
    .map((s) => ({ t: new Date(s.at).getTime(), v: s.mc_usd! }));
  const last = d.lastScan;
  const tape = last?.tape?.lead ?? t.tape_lead ?? "unknown";

  return (
    <div className="page">
      <header className="topbar">
        <button type="button" className="back" onClick={() => nav("/")}>← Ward</button>
        <div className={`live-dot ${connected ? "on" : ""}`} />
      </header>

      <div className="hero">
        {t.image && (
          <img src={t.image} alt="" className="thumb" style={{ width: 56, height: 56, borderRadius: 18 }} />
        )}
        <div className="hero-copy">
          <h1>${t.symbol || t.name || shortMint(t.mint)}</h1>
          <div className="mint">{t.mint}</div>
          <div style={{ marginTop: 8 }}>
            <span className={`badge phase-${phase}`}>{PHASE_META[phase]?.label ?? phase}</span>
            {" "}
            <span className={`badge phase-ward tape-${tape}`}>{tape.replace("_", " ")}</span>
          </div>
          <p className="blurb" style={{ marginTop: 8 }}>{PHASE_META[phase]?.hint}</p>
        </div>
      </div>

      <div className="stat">
        <div className="big-score">
          {t.survival_score ?? "—"}
          <small>Survival score · {t.wallet_buys} tracked wallet{t.wallet_buys === 1 ? "" : "s"}</small>
        </div>
      </div>

      <div className="grid3">
        <div className="vit"><b>{fmtUsd(t.last_mc)}</b><span>Market cap</span></div>
        <div className="vit"><b>{fmtUsd(t.last_liq)}</b><span>Liquidity</span></div>
        <div className="vit"><b>{t.last_holders ?? "—"}</b><span>Holders</span></div>
        <div className="vit"><b>{fmtUsd(t.admission_mc)}</b><span>Admit MC</span></div>
        <div className="vit"><b>{fmtX(t.xFromAdmit)}</b><span>Since admit</span></div>
        <div className="vit"><b>{fmtX(t.peakX)}</b><span>Peak</span></div>
      </div>

      <div className="section-h">How it decided</div>
      <Factors factors={factors} />

      <div className="section-h">Holder quality</div>
      <div className="grid3">
        <div className="vit"><b>{fmtPct(last?.top10_pct)}</b><span>Top 10</span></div>
        <div className="vit"><b>{fmtPct(last?.bundler_pct)}</b><span>Bundlers</span></div>
        <div className="vit"><b>{fmtPct(last?.bot_pct)}</b><span>Bot hold</span></div>
        <div className="vit"><b>{fmtPct(last?.sniper_pct)}</b><span>Snipers</span></div>
        <div className="vit"><b>{last?.smart_count ?? "—"}</b><span>Smart</span></div>
        <div className="vit"><b>{fmtPct(last?.whale_pct)}</b><span>Whales</span></div>
      </div>

      <div className="section-h">Tape (5m)</div>
      <div className="grid3">
        <div className="vit"><b>{last?.buys_5m ?? "—"}</b><span>Buys</span></div>
        <div className="vit"><b>{last?.sells_5m ?? "—"}</b><span>Sells</span></div>
        <div className="vit"><b>{fmtUsd(last?.vol_5m)}</b><span>Volume</span></div>
      </div>

      <div className="section-h">Market cap since admit</div>
      <Spark points={spark} admit={t.admission_mc} />

      <div className="section-h">Admitting wallets</div>
      <div className="list">
        {d.admissions.length === 0 && <div className="row"><span className="blurb">No wallet rows yet</span></div>}
        {d.admissions.map((a) => (
          <div key={`${a.wallet}-${a.at}`} className="row">
            <span>{a.label || shortWallet(a.wallet)}</span>
            <span className="blurb">{timeAgo(a.at)}</span>
          </div>
        ))}
      </div>

      <div className="section-h">Alerts</div>
      {d.alerts.length === 0 && <div className="empty">No alerts for this patient.</div>}
      {d.alerts.slice(0, 8).map((a) => (
        <div key={a.id} className={`alert kind-${a.kind}`}>
          <div className="k">{a.kind} · {timeAgo(a.at)}</div>
          <h3>{a.title}</h3>
          {a.body && <p>{a.body}</p>}
        </div>
      ))}

      <div className="section-h">Agent notes</div>
      <div className="list">
        {d.notes.slice(0, 12).map((n, i) => (
          <div key={`${n.at}-${i}`} className="agent-row">
            <b>{n.agent}<br /><small>{timeAgo(n.at)}</small></b>
            <p>{n.detail}</p>
          </div>
        ))}
        {d.notes.length === 0 && <div className="row"><span className="blurb">Agents have not written yet.</span></div>}
      </div>

      <div className="links">
        <a className="link" href={`https://dexscreener.com/solana/${t.mint}`} target="_blank" rel="noreferrer">DexScreener</a>
        <a className="link" href={`https://gmgn.ai/sol/token/${t.mint}`} target="_blank" rel="noreferrer">GMGN</a>
        <a className="link" href={`https://pump.fun/coin/${t.mint}`} target="_blank" rel="noreferrer">pump.fun</a>
        <a className="link" href={`https://solscan.io/token/${t.mint}`} target="_blank" rel="noreferrer">Solscan</a>
      </div>
    </div>
  );
}
