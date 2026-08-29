import { useLocation, useParams } from "wouter";
import { api, fmtUsd, fmtGainPct, gmgnUrl, shortMint, shortWallet, timeAgo, type TokenChart } from "../lib/api";
import { usePoll } from "../hooks/use-data";
import { Gain, LabelChip, TokenImg } from "../components/pass-card";

export default function TokenPage() {
  const { id } = useParams<{ id: string }>();
  const [, nav] = useLocation();
  const q = usePoll<TokenChart>(
    () => api(`api/tokens/${id}`),
    15_000,
    [id],
  );
  const t = q.data?.token;
  const ads = q.data?.admissions ?? [];
  const scans = q.data?.scans ?? [];

  if (q.loading && !t) {
    return <div className="page"><div className="skel" /></div>;
  }
  if (q.error || !t) {
    return (
      <div className="page">
        <button type="button" className="back" onClick={() => nav("/")}>← Desk</button>
        <div className="empty err">{q.error || "Not found"}</div>
      </div>
    );
  }

  return (
    <div className="page">
      <button type="button" className="back" onClick={() => nav("/")}>← Desk</button>
      <div className="hero">
        <TokenImg src={t.image} mint={t.mint} letter={t.symbol || t.name || t.mint} className="thumb lg" />
        <div>
          <h1>${t.symbol || t.name || shortMint(t.mint)}</h1>
          <div className="muted mint">{t.mint}</div>
          <div className="hero-cta">
            <a className="chip on" href={gmgnUrl(t.mint)} target="_blank" rel="noreferrer">Open GMGN</a>
            <span className={`st ${t.status}`}>{t.status === "dead" ? "archived" : t.status}</span>
            <LabelChip label={t.label} />
          </div>
        </div>
      </div>

      <div className="nums">
        <div className="num">
          <div className="k">Detected MC</div>
          <div className="v">{fmtUsd(t.detected_mc)}</div>
        </div>
        <div className="num">
          <div className="k">Now</div>
          <div className="v">{fmtUsd(t.last_mc)}</div>
        </div>
        <div className="num">
          <div className="k">Gain</div>
          <div className={`v ${t.gain_pct != null && t.gain_pct < 0 ? "dn" : t.gain_pct != null ? "up" : ""}`}>
            {fmtGainPct(t.gain_pct)}
          </div>
        </div>
        <div className="num">
          <div className="k">ATH vs buy</div>
          <div className="v">{fmtGainPct(t.ath_pct)}</div>
        </div>
        <div className="num">
          <div className="k">Frozen score</div>
          <div className="v">{t.score ?? "—"}</div>
          <div className="muted">
            {t.prev_score != null ? `was ${t.prev_score}` : "at last print"}
            {t.score != null && t.prev_score != null ? ` · ${t.score - t.prev_score >= 0 ? "+" : ""}${t.score - t.prev_score}` : ""}
          </div>
        </div>
      </div>

      {(q.data?.memory?.[0]?.catalyst) ? (
        <p className="note"><b>Catalyst. </b>{q.data.memory[0].catalyst}</p>
      ) : null}

      <div className="h">Wallets</div>
      {ads.length === 0 ? <div className="empty">No buy signatures stored.</div> : null}
      {ads.map((a) => (
        <div key={`${a.wallet}-${a.at}`} className="line">
          <b>{a.label || shortWallet(a.wallet)}</b>
          <span className="muted">{timeAgo(a.at)}</span>
        </div>
      ))}

      <div className="h">Memory</div>
      {(q.data?.memory ?? []).length === 0 ? <div className="empty">No snapshots yet. Scans still print below.</div> : null}
      {(q.data?.memory ?? []).slice(0, 12).map((s) => (
        <div key={s.at} className="line">
          <b>{fmtUsd(s.mc_usd)}</b>
          <Gain pct={s.gain_pct} />
          {s.score != null ? <span className="lb watch">{s.score}{s.score_delta != null ? ` ${s.score_delta >= 0 ? "+" : ""}${s.score_delta}` : ""}</span> : null}
          <LabelChip label={s.label} />
          <span className="muted">{s.survived === false ? "dead" : s.wallets ? `${s.wallets}w` : ""}{s.mc_delta_pct != null ? ` · MC ${fmtGainPct(s.mc_delta_pct)}` : ""} · {timeAgo(s.at)}</span>
        </div>
      ))}

      <div className="h">Scans</div>
      {scans.length === 0 ? <div className="empty">No MC prints yet.</div> : null}
      {scans.slice(0, 12).map((s) => (
        <div key={s.at} className="line">
          <b>{fmtUsd(s.mc_usd)}</b>
          <Gain pct={t.detected_mc && s.mc_usd ? ((s.mc_usd / t.detected_mc) - 1) * 100 : null} />
          <span className="muted">{timeAgo(s.at)}</span>
        </div>
      ))}
    </div>
  );
}
