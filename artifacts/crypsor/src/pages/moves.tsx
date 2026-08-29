import { useState } from "react";
import {
  api, fmtUsd, gmgnTxUrl, gmgnWalletUrl, isSolanaAddress, rhAddressUrl, rhTxUrl,
  shortMint, shortWallet, timeAgo,
  type IntelEvent, type IntelKind, type MovesBoard,
} from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";

type ChainFilter = "all" | "sol" | "robinhood";
type KindFilter = "all" | IntelKind;

function explorerWallet(e: IntelEvent): string {
  if (e.chain === "robinhood") return rhAddressUrl(e.wallet);
  return gmgnWalletUrl(e.wallet);
}

function explorerTx(e: IntelEvent): string | null {
  if (!e.tx || e.tx.startsWith("pair:")) return null;
  if (e.chain === "robinhood") return rhTxUrl(e.tx);
  return gmgnTxUrl(e.tx);
}

function titleOf(e: IntelEvent): string {
  const token = e.symbol ? `$${e.symbol}` : e.name;
  if (e.kind === "fund") return token ? `${token} in` : "Fund in";
  if (e.kind === "buy") return token ? `Bought ${token}` : "Memecoin buy";
  if (e.kind === "sell") return token ? `Sold ${token}` : "Memecoin sell";
  return token ? `New pair ${token}` : "Deploy / new pair";
}

function canTrack(e: IntelEvent): boolean {
  return e.kind !== "deploy" && e.chain === "sol" && isSolanaAddress(e.wallet);
}

export default function MovesPage() {
  const { tick } = useSse();
  const [chain, setChain] = useState<ChainFilter>("all");
  const [kind, setKind] = useState<KindFilter>("all");
  const [rumorOnly, setRumorOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const qs = new URLSearchParams();
  if (chain !== "all") qs.set("chain", chain);
  if (kind !== "all") qs.set("kind", kind);
  if (rumorOnly) qs.set("rumor", "1");
  qs.set("page", String(page));
  qs.set("limit", "40");

  const q = usePoll<MovesBoard>(
    () => api(`api/moves?${qs.toString()}`),
    20_000,
    [tick, chain, kind, rumorOnly, page],
  );
  const items = q.data?.items ?? [];
  const pages = q.data?.pages ?? 1;

  const copy = async (wallet: string) => {
    try {
      await navigator.clipboard.writeText(wallet);
      setCopied(wallet);
      setTimeout(() => setCopied((c) => (c === wallet ? null : c)), 1200);
    } catch {
      setMsg("copy failed");
    }
  };

  const track = async (e: IntelEvent) => {
    setMsg(null);
    try {
      const label = [e.symbol ? `$${e.symbol}` : null, e.kind, "moves"].filter(Boolean).join(" ");
      await api("api/wallets", { method: "POST", body: JSON.stringify({ address: e.wallet, label }) });
      setMsg(`Tracked ${shortWallet(e.wallet)} — desk will watch buys from here. This row is still just a log.`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "track failed");
    }
  };

  return (
    <div className="page wide">
      <div className="head">
        <h1>Moves</h1>
        <span className="muted">Observation log · Solana + Robinhood Chain</span>
      </div>
      <p className="note">
        Big deposits, memecoin buys/sells, and young rumor-named pairs. This is a log,
        not a call and not a desk gate — nothing here auto-admits a token. Rumor name
        hits (trump, wlfi, and similar) are tags only. Eric Trump has called a new
        official family coin rumor fraud; old official TRUMP/MELANIA pairs are ignored.
        Tracked desk wallets are skipped so watchout buys stay on the desk.
      </p>

      <div className="toolbar">
        {(["all", "sol", "robinhood"] as const).map((c) => (
          <button
            key={c}
            type="button"
            className={`chip ${chain === c ? "on" : ""}`}
            onClick={() => { setChain(c); setPage(1); }}
          >
            {c === "all" ? "All chains" : c === "sol" ? "Solana" : "Robinhood"}
          </button>
        ))}
        {(["all", "fund", "buy", "sell", "deploy"] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={`chip ${kind === k ? "on" : ""}`}
            onClick={() => { setKind(k); setPage(1); }}
          >
            {k === "all" ? "All kinds" : k}
          </button>
        ))}
        <button
          type="button"
          className={`chip ${rumorOnly ? "on" : ""}`}
          onClick={() => { setRumorOnly((v) => !v); setPage(1); }}
        >
          Rumor tags
        </button>
        <span className="muted">{q.data?.total ?? 0} rows</span>
      </div>

      {msg ? <div className={msg.startsWith("Tracked") ? "note ok" : "note err"}>{msg}</div> : null}
      {q.loading && !q.data ? <div className="skel" /> : null}
      {q.error ? <div className="empty err">{q.error}</div> : null}
      {!q.loading && items.length === 0 && !q.error ? (
        <div className="empty">Nothing logged yet. The tape checks pump newest, Helius inflows, Robinhood blocks, and Dex rumor names about every 50s.</div>
      ) : null}

      <div className="rows">
        {items.map((e) => {
          const txHref = explorerTx(e);
          return (
            <div key={e.id} className="tok-card scout-card move-card">
              <div className="card-main">
                <div className="sym">
                  {titleOf(e)}
                  <span className={`st ${e.kind}`}>{e.kind}</span>
                  <span className="st">{e.chain === "robinhood" ? "robinhood" : "sol"}</span>
                  {e.rumor ? <span className="st rumor">tag {e.rumor}</span> : null}
                </div>
                <div className="meta">{e.detail}</div>
                <div className="tok-grid">
                  <span>wallet <code>{shortWallet(e.wallet)}</code></span>
                  {e.counterparty ? <span>from <code>{shortWallet(e.counterparty)}</code></span> : null}
                  {e.mint ? <span>mint <code>{shortMint(e.mint)}</code></span> : null}
                  <span>{fmtUsd(e.usd)}</span>
                  {e.nativeAmt != null ? <span>{e.nativeAmt >= 1 ? e.nativeAmt.toFixed(2) : e.nativeAmt.toPrecision(3)} {e.chain === "robinhood" ? "ETH" : "SOL"}</span> : null}
                  <span className="muted">{timeAgo(e.at)}</span>
                </div>
              </div>
              <div className="side scout-actions">
                <button type="button" className="chip" onClick={() => void copy(e.wallet)}>
                  {copied === e.wallet ? "Copied" : "Copy"}
                </button>
                <a className="gmgn-ic" href={explorerWallet(e)} target="_blank" rel="noreferrer" aria-label="Open wallet">
                  {e.chain === "robinhood" ? "R" : "G"}
                </a>
                {txHref ? (
                  <a className="chip" href={txHref} target="_blank" rel="noreferrer">Tx</a>
                ) : null}
                {canTrack(e) ? (
                  <button type="button" className="chip" onClick={() => void track(e)}>Track</button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {pages > 1 ? (
        <div className="pager">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</button>
          <span className="muted">{page} / {pages}</span>
          <button type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      ) : null}
    </div>
  );
}
