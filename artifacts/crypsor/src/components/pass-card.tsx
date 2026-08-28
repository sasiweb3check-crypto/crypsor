import { useState } from "react";
import {
  fmtUsd, fmtGainPct, fmtPassAt, gmgnUrl, deskImg,
  type PassCard as Pass,
} from "../lib/api";

export function Gain({ pct, className = "mult" }: { pct: number | null; className?: string }) {
  const up = pct != null && pct >= 0;
  return <span className={`${className} ${pct == null ? "" : up ? "up" : "down"}`}>{fmtGainPct(pct)}</span>;
}

export function TokenImg({
  src, letter, className = "thumb lg",
}: {
  src: string | null | undefined;
  letter: string;
  className?: string;
}) {
  const proxied = deskImg(src);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const mark = (letter || "?").slice(0, 1).toUpperCase();
  if (!proxied || failedSrc === proxied) {
    return <span className={`${className} blank`} aria-hidden>{mark}</span>;
  }
  return (
    <img
      src={proxied}
      alt=""
      className={className}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailedSrc(proxied)}
    />
  );
}

function letterOf(p: { symbol?: string | null; name?: string | null; mint: string }): string {
  return p.symbol || p.name || p.mint;
}

function momClass(m: Pass["momentum"]): string {
  if (m === "up") return "up";
  if (m === "down") return "down";
  return "";
}

export function sourceLabel(source: string): string {
  if (source === "dex_boost") return "Dex boost";
  if (source === "public_tape") return "Dex";
  if (source === "pump_mover" || source === "pump_live") return "pump.fun";
  if (source === "gecko") return "CoinGecko";
  if (source === "wallet_buy") return "wallet";
  return source.replace(/_/g, " ");
}

export function GmgnLink({ mint }: { mint: string }) {
  return (
    <a
      className="gmgn-ic"
      href={gmgnUrl(mint)}
      target="_blank"
      rel="noreferrer"
      aria-label="Open on GMGN"
      onClick={(e) => e.stopPropagation()}
    >
      G
    </a>
  );
}

export function PassRow({
  p, onOpen,
}: {
  p: Pass;
  onOpen: () => void;
}) {
  const lane = p.lane === "dead" ? "dead" : p.status === "trim" ? "trim" : "live";
  const surv = p.survival;
  return (
    <div className={`trade rich ${lane}`}>
      <button type="button" className="thumb-hit" onClick={onOpen}>
        <TokenImg src={p.image} letter={letterOf(p)} className="thumb lg" />
      </button>
      <button type="button" className="card-main" onClick={onOpen}>
        <div className="sym">
          ${p.symbol || p.name || p.mint.slice(0, 6)}
          {p.hotness != null && <span className="st band">hot {Math.round(p.hotness)}</span>}
          {p.band && <span className="st band">{p.band}</span>}
          {p.momentum && p.momentum !== "unread" && (
            <span className={`st mom ${momClass(p.momentum)}`}>{p.momentum}</span>
          )}
        </div>
        <div className="meta">
          {p.status === "watch" ? "live tape" : `passed ${fmtPassAt(p.passed_at)}`}
          {" · "}{fmtUsd(p.pass_mc || p.last_mc)}
        </div>
        <div className="pass-now">
          now {fmtUsd(p.last_mc)} · ATH vs entry <Gain pct={p.ath_pct} className="inline-gain" />
          {surv != null && <> · surv {Math.round(surv)}</>}
        </div>
      </button>
      <div className="pass-side">
        <Gain pct={p.gain_pct} />
        <GmgnLink mint={p.mint} />
      </div>
    </div>
  );
}

export function PerformerCard({ p, onOpen }: { p: Pass; onOpen: () => void }) {
  return (
    <div className="performer-card">
      <button type="button" className="performer-open" onClick={onOpen}>
        <TokenImg src={p.image} letter={letterOf(p)} />
        <b>${p.symbol || p.mint.slice(0, 4)}</b>
        <Gain pct={p.ath_pct} className="inline-gain" />
        <em>{p.hotness != null ? `hot ${Math.round(p.hotness)}` : "ATH vs entry"}</em>
      </button>
      <GmgnLink mint={p.mint} />
    </div>
  );
}
