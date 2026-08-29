import { useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import {
  api, deskImg, fmtUsd, gmgnWalletUrl, shortWallet, timeAgo,
  type ScoutJob, type ScoutWalletRow,
} from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";

function authLabel(v: string | null | undefined): string {
  if (v == null || v === "") return "revoked";
  return shortWallet(v);
}

function fmtRoi(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const pct = v * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${Math.abs(pct) >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

function fmtHold(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

function filterRows(
  rows: ScoutWalletRow[],
  maxMc: number | null,
  profitable: boolean,
  hideLp: boolean,
): ScoutWalletRow[] {
  return rows.filter((w) => {
    if (hideLp && w.lpLike) return false;
    if (profitable && !(w.profitUsd > 0)) return false;
    if (maxMc != null) {
      if (w.minBuyMc == null || w.minBuyMc > maxMc) return false;
    }
    return true;
  });
}

export default function ScoutPage() {
  const params = useParams<{ id?: string }>();
  const [, nav] = useLocation();
  const jobId = params.id ? parseInt(params.id, 10) : NaN;
  const { tick } = useSse();
  const [mint, setMint] = useState("");
  const [band, setBand] = useState("");
  const [profitable, setProfitable] = useState(true);
  const [hideLp, setHideLp] = useState(true);
  const [sort, setSort] = useState<"profit" | "roi" | "winrate" | "cycles">("profit");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [enriching, setEnriching] = useState<string | null>(null);

  const interval = Number.isFinite(jobId) ? 2_000 : 60_000;
  const q = usePoll<ScoutJob | null>(
    () => (Number.isFinite(jobId) ? api<ScoutJob>(`api/scout/${jobId}`) : Promise.resolve(null)),
    interval,
    [jobId, tick],
  );
  const job = q.data;
  const running = job?.status === "queued" || job?.status === "running";

  const maxMc = (() => {
    const n = Number(band.replace(/[,_ ]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  })();

  const rows = useMemo(() => {
    const list = filterRows(job?.wallets ?? [], maxMc, profitable, hideLp);
    return [...list].sort((a, b) => {
      if (sort === "roi") return (b.overallRoi ?? -999) - (a.overallRoi ?? -999);
      if (sort === "winrate") return (b.winrate ?? -1) - (a.winrate ?? -1);
      if (sort === "cycles") return b.closedCycles - a.closedCycles;
      return b.profitUsd - a.profitUsd;
    });
  }, [job?.wallets, maxMc, profitable, hideLp, sort]);

  const run = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const started = await api<ScoutJob>("api/scout", {
        method: "POST",
        body: JSON.stringify({ mint }),
      });
      setMint("");
      nav(`/scout/${started.id}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "start failed");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (wallet: string) => {
    try {
      await navigator.clipboard.writeText(wallet);
      setCopied(wallet);
      setTimeout(() => setCopied((c) => (c === wallet ? null : c)), 1200);
    } catch {
      setMsg("copy failed");
    }
  };

  const track = async (w: ScoutWalletRow) => {
    setMsg(null);
    try {
      const label = [job?.token?.symbol ? `$${job.token.symbol}` : null, "scout"].filter(Boolean).join(" ");
      await api("api/wallets", { method: "POST", body: JSON.stringify({ address: w.wallet, label }) });
      setMsg(`Tracked ${shortWallet(w.wallet)}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "track failed");
    }
  };

  const enrich = async (wallet: string) => {
    if (!Number.isFinite(jobId)) return;
    setEnriching(wallet);
    setMsg(null);
    try {
      await api<ScoutJob>(`api/scout/${jobId}/enrich`, {
        method: "POST",
        body: JSON.stringify({ wallet }),
        signal: AbortSignal.timeout(45_000),
      });
      q.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "enrich failed");
    } finally {
      setEnriching(null);
    }
  };

  const t = job?.token;

  return (
    <div className="page wide">
      <div className="head">
        <h1>Wallet scout</h1>
      </div>
      <p className="note">
        Enter a mint. We rebuild this token&apos;s tape from pump.fun trades, Helius pool
        history, and current holders, then fill gaps from GMGN&apos;s public token trades,
        holders, smart-money, and wallet activity. Rank is our reconstructed ROI — GMGN
        PnL is never copied. MC band is a post-filter on buys we already stamped.
      </p>

      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          value={mint}
          onChange={(e) => setMint(e.target.value.trim())}
          placeholder="Solana token mint"
          aria-label="Token mint"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button type="submit" className="btn" disabled={busy || mint.length < 32}>
          {busy ? "Starting…" : "Scout"}
        </button>
      </form>
      {msg ? <div className={msg.startsWith("Tracked") ? "note ok" : "note err"}>{msg}</div> : null}
      {q.error ? <div className="empty err">{q.error}</div> : null}
      {q.loading && Number.isFinite(jobId) && !job ? <div className="skel" /> : null}

      {running ? (
        <p className="note">
          <b>{job?.phase ?? "running"}.</b> {job?.detail}
          {job?.progress_n != null && job?.progress_of != null ? ` · ${job.progress_n}/${job.progress_of}` : ""}
        </p>
      ) : null}
      {job?.status === "error" ? <div className="empty err">{job.error || job.detail}</div> : null}

      {t ? (
        <>
          <div className="hero">
            {t.image ? <img src={deskImg(t.image, t.mint) ?? t.image} alt="" className="thumb lg" /> : <span className="thumb lg blank">$</span>}
            <div>
              <h1>${t.symbol || t.name || shortWallet(t.mint)}</h1>
              <div className="muted mint">{t.mint}</div>
              <div className="muted">
                {t.launchpad ?? "unknown launchpad"}
                {t.createdAt ? ` · ${timeAgo(t.createdAt)}` : ""}
                {` · mint ${authLabel(t.mintAuthority)} · freeze ${authLabel(t.freezeAuthority)}`}
              </div>
            </div>
          </div>
          <div className="nums">
            <div className="num"><div className="k">MC</div><div className="v">{fmtUsd(t.mcUsd)}</div></div>
            <div className="num"><div className="k">Price</div><div className="v">{t.priceUsd != null ? `$${t.priceUsd < 0.01 ? t.priceUsd.toExponential(2) : t.priceUsd.toPrecision(4)}` : "—"}</div></div>
            <div className="num"><div className="k">Liq</div><div className="v">{fmtUsd(t.liqUsd)}</div></div>
            <div className="num"><div className="k">Supply</div><div className="v">{t.supply != null ? t.supply.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"}</div></div>
            <div className="num"><div className="k">Fills</div><div className="v">{job?.fills_n ?? "—"}</div></div>
          </div>
        </>
      ) : null}

      {job?.status === "done" ? (
        <>
          <div className="toolbar">
            <label className="muted">
              MC band
              <input
                value={band}
                onChange={(e) => setBand(e.target.value)}
                placeholder="e.g. 50000 — empty = off"
                aria-label="Max market cap at buy"
                inputMode="numeric"
              />
            </label>
            <button type="button" className={`chip ${profitable ? "on" : ""}`} onClick={() => setProfitable((v) => !v)}>
              Profitable
            </button>
            <button type="button" className={`chip ${hideLp ? "on" : ""}`} onClick={() => setHideLp((v) => !v)}>
              Hide LP-like
            </button>
            {(["profit", "roi", "winrate", "cycles"] as const).map((s) => (
              <button key={s} type="button" className={`chip ${sort === s ? "on" : ""}`} onClick={() => setSort(s)}>
                {s}
              </button>
            ))}
            <span className="muted">{rows.length} wallets{maxMc != null ? ` · buys ≤ ${fmtUsd(maxMc)} MC` : ""}</span>
          </div>

          <div className="rows scout-rows">
            {rows.length === 0 ? <div className="empty">No wallets in this filter. Raise the MC band or show unprofitable.</div> : null}
            {rows.map((w) => (
              <div key={w.wallet} className="tok-card scout-card">
                <div className="card-main">
                  <div className="sym">
                    <code>{shortWallet(w.wallet)}</code>
                    <span className={`st ${w.status}`}>{w.status.replace("_", " ")}</span>
                    {w.gap ? <span className="st gap">{(w.gmgnLegs ?? 0) > 0 ? "gmgn gap" : "tags only"}</span> : null}
                    {(w.gmgnLegs ?? 0) > 0 && !w.gap ? <span className="st gap">gmgn {w.gmgnLegs}</span> : null}
                    {w.lpLike ? <span className="risk caution">lp-like</span> : null}
                    {w.labels.map((l) => <span key={l} className="factor">{l.replace("name:", "")}</span>)}
                  </div>
                  <div className="tok-grid">
                    <span>ROI <b className={w.overallRoi != null && w.overallRoi >= 0 ? "ok" : "err"}>{fmtRoi(w.overallRoi)}</b></span>
                    <span>profit <b>{fmtUsd(w.profitUsd)}</b></span>
                    <span>in {fmtUsd(w.investedUsd)}</span>
                    <span>out {fmtUsd(w.proceedsUsd)}</span>
                    <span>avg buy {w.avgBuy != null ? `$${w.avgBuy < 0.01 ? w.avgBuy.toExponential(2) : w.avgBuy.toPrecision(3)}` : "—"}</span>
                    <span>avg sell {w.avgSell != null ? `$${w.avgSell < 0.01 ? w.avgSell.toExponential(2) : w.avgSell.toPrecision(3)}` : "—"}</span>
                    <span>win {w.winrate != null ? `${Math.round(w.winrate * 100)}%` : "—"}</span>
                    <span>{w.closedCycles} cycles · {w.legs} legs</span>
                    <span>hold {fmtHold(w.avgHoldMs)}</span>
                    <span>min buy MC {fmtUsd(w.minBuyMc)}</span>
                  </div>
                </div>
                <div className="side scout-actions">
                  <button type="button" className="chip" onClick={() => void copy(w.wallet)}>
                    {copied === w.wallet ? "Copied" : "Copy"}
                  </button>
                  <a className="gmgn-ic" href={gmgnWalletUrl(w.wallet)} target="_blank" rel="noreferrer" aria-label="GMGN wallet">G</a>
                  <button type="button" className="chip" onClick={() => void track(w)}>Track</button>
                  <button
                    type="button"
                    className="chip"
                    disabled={enriching === w.wallet}
                    onClick={() => void enrich(w.wallet)}
                  >
                    {enriching === w.wallet ? "…" : "Enrich"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {(job?.notes ?? []).length > 0 ? (
        <div className="h">Approximations</div>
      ) : null}
      {(job?.notes ?? []).map((n) => (
        <p key={n} className="note">{n}</p>
      ))}
    </div>
  );
}
