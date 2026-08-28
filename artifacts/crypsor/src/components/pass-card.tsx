import { useState } from "react";
import {
  fmtUsd, fmtGainPct, fmtPassAt,
  type PassCard as Pass,
  type TapeName,
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
  const https = src && /^https:\/\//i.test(src) ? src : null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const mark = (letter || "?").slice(0, 1).toUpperCase();
  if (!https || failedSrc === https) {
    return <span className={`${className} blank`} aria-hidden>{mark}</span>;
  }
  return (
    <img
      src={https}
      alt=""
      className={className}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailedSrc(https)}
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
      <TokenImg src={p.image} letter={letterOf(p)} className="thumb lg" />
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
            now {fmtUsd(p.last_mc)} · ATH vs entry <Gain pct={p.ath_pct} className="inline-gain" />
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
        {compact && <em>ATH vs entry {fmtGainPct(p.ath_pct)}</em>}
      </div>
    </button>
  );
}

export function PerformerCard({ p, onOpen }: { p: Pass; onOpen: () => void }) {
  return (
    <button type="button" className="performer-card" onClick={onOpen}>
      <TokenImg src={p.image} letter={letterOf(p)} />
      <b>${p.symbol || p.mint.slice(0, 4)}</b>
      <Gain pct={p.ath_pct} className="inline-gain" />
      <em>{p.momentum && p.momentum !== "unread" ? p.momentum : "ATH vs entry"}</em>
    </button>
  );
}

export function TapeRow({
  t, onOpen, waiting = false,
}: {
  t: TapeName;
  onOpen: () => void;
  waiting?: boolean;
}) {
  const sent = t.sentiment;
  return (
    <button type="button" className={`trade rich tape ${waiting ? "wait" : "suggest"}`} onClick={onOpen}>
      <TokenImg src={t.image} letter={letterOf(t)} className="thumb lg" />
      <div className="card-main">
        <div className="sym">
          ${t.symbol || t.name || t.mint.slice(0, 6)}
          <span className="st band">{sourceLabel(t.source)}</span>
          {sent && <span className={`st sent ${sent}`}>{sent}</span>}
        </div>
        <div className="meta">
          {waiting
            ? "waiting on scanner"
            : `${fmtUsd(t.last_mc)} · not a pass`}
          {t.socials.length ? ` · ${t.socials.join(" · ")}` : ""}
        </div>
        {!waiting && t.thesis && <p className="story-clip">{t.thesis}</p>}
        {waiting && t.story && <p className="story-clip">{t.story}</p>}
      </div>
      <div className="pass-side">
        {waiting ? <em>queue</em> : <Gain pct={t.ath_pct ?? null} />}
      </div>
    </button>
  );
}
