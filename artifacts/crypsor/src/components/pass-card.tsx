import { useState } from "react";
import {
  fmtUsd, fmtGainPct, deskImg, gmgnUrl, timeAgo,
  type TokenCard,
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

export function TokenRow({ p, onOpen }: { p: TokenCard; onOpen: () => void }) {
  return (
    <div className={`row-card ${p.status}`}>
      <button type="button" className="thumb-hit" onClick={onOpen}>
        <TokenImg src={p.image} mint={p.mint} letter={letterOf(p)} />
      </button>
      <button type="button" className="card-main" onClick={onOpen}>
        <div className="sym">
          ${p.symbol || p.name || p.mint.slice(0, 6)}
          <span className={`st ${p.status}`}>{p.status === "dead" ? "archived" : p.status}</span>
        </div>
        <div className="meta">
          detected {fmtUsd(p.detected_mc)} · now {fmtUsd(p.last_mc)}
          {p.wallet_buys ? ` · ${p.wallet_buys} wallet${p.wallet_buys === 1 ? "" : "s"}` : ""}
          {p.last_scan_at ? ` · ${timeAgo(p.last_scan_at)}` : ""}
        </div>
      </button>
      <div className="side">
        <Gain pct={p.gain_pct} />
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
      </div>
    </div>
  );
}

export function PerformerCard({ p, onOpen }: { p: TokenCard; onOpen: () => void }) {
  return (
    <button type="button" className="performer" onClick={onOpen}>
      <TokenImg src={p.image} mint={p.mint} letter={letterOf(p)} />
      <b>${p.symbol || p.mint.slice(0, 4)}</b>
      <Gain pct={p.gain_pct} />
    </button>
  );
}
