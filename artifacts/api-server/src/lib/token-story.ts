/**
 * Token story — turns the snapshot tape into a plain-English trader summary.
 *
 * Generated fresh on every detail request from real evidence (tape deltas,
 * holder trend, liquidity retention, GEM verdict) — no canned per-token text.
 * Output: a mood, a one-line headline, and 2-4 short supporting lines a
 * trader can absorb in five seconds.
 */

import type { SurvivalResult } from "./survival-score";

export type StoryTapePoint = {
  atMs: number;
  mcUsd: number | null;
  liqUsd: number | null;
  buys5m: number | null;
  sells5m: number | null;
  holderCount: number | null;
};

export type StoryInputs = {
  symbol: string;
  tape: StoryTapePoint[];              // oldest → newest
  callMcUsd: number | null;            // GEM call anchor (null = not called)
  peakMcUsd: number | null;
  currentMcUsd: number;
  liqUsd: number | null;
  minutesSinceDetect: number | null;
  gemScore: number | null;
  gemVerdict: string | null;
  gemVetoes: string[];
  survival: SurvivalResult | null;
  holderCount: number | null;
  top10Pct: number | null;
  trackedWallets: number;
};

export type TokenStory = {
  mood: "bullish" | "neutral" | "bearish" | "danger";
  headline: string;
  lines: string[];
};

const fmtUsd = (v: number) =>
  v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M`
    : v >= 1_000 ? `$${(v / 1_000).toFixed(1)}K`
      : `$${Math.round(v)}`;

function windowChangePct(tape: StoryTapePoint[], minutes: number): number | null {
  const pts = tape.filter((p) => p.mcUsd != null && p.mcUsd > 0);
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1];
  const cutoff = last.atMs - minutes * 60_000;
  const start = pts.find((p) => p.atMs >= cutoff) ?? pts[0];
  if (start === last || !(start.mcUsd! > 0)) return null;
  return ((last.mcUsd! - start.mcUsd!) / start.mcUsd!) * 100;
}

function recentBuyRatio(tape: StoryTapePoint[]): number | null {
  const recent = tape.slice(-6);
  let buys = 0;
  let sells = 0;
  for (const p of recent) {
    buys += p.buys5m ?? 0;
    sells += p.sells5m ?? 0;
  }
  return buys + sells >= 6 ? buys / (buys + sells) : null;
}

export function buildTokenStory(i: StoryInputs): TokenStory {
  const lines: string[] = [];
  const chg10 = windowChangePct(i.tape, 10);
  const chg30 = windowChangePct(i.tape, 30);
  const buyRatio = recentBuyRatio(i.tape);
  const sym = `$${i.symbol}`;

  // ── Phase detection from the last ~10/30 min ──
  type Phase = "exploding" | "climbing" | "flat" | "cooling" | "bleeding" | "recovering";
  let phase: Phase = "flat";
  if (chg10 != null) {
    if (chg10 >= 25) phase = "exploding";
    else if (chg10 >= 6) phase = "climbing";
    else if (chg10 <= -15) phase = "bleeding";
    else if (chg10 <= -4) phase = "cooling";
    else if ((chg30 ?? 0) <= -12 && chg10 > 0) phase = "recovering";
  }

  // ── Danger first: vetoes / LP pull dominate every other narrative ──
  const liqPulled = i.survival != null && i.survival.components.liq <= 10;
  if (i.gemVetoes.length > 0 || liqPulled) {
    const reason = liqPulled
      ? "liquidity is being pulled from the pool"
      : i.gemVetoes.includes("honeypot") ? "it flags as a honeypot"
        : i.gemVetoes.some((v) => v.startsWith("top10")) ? "supply is concentrated in a few wallets"
          : i.gemVetoes.some((v) => v.includes("sniper") || v.includes("bundler")) ? "the launch is bot-swarmed"
            : "it failed a safety check";
    return {
      mood: "danger",
      headline: `${sym} is flagged — ${reason}.`,
      lines: [
        ...(liqPulled ? [`Liquidity retention broke down — treat any bounce as exit-only.`] : []),
        ...(i.gemVetoes.length ? [`Failed checks: ${i.gemVetoes.join(", ")}.`] : []),
        `Current MC ${fmtUsd(i.currentMcUsd)}${i.liqUsd ? ` on ${fmtUsd(i.liqUsd)} liquidity` : ""}.`,
      ],
    };
  }

  // ── Headline by phase ──
  const phaseHeadline: Record<Phase, string> = {
    exploding: `${sym} is exploding — +${Math.round(chg10 ?? 0)}% in ~10 min.`,
    climbing: `${sym} is climbing steadily — +${Math.round(chg10 ?? 0)}% in ~10 min.`,
    flat: `${sym} is consolidating around ${fmtUsd(i.currentMcUsd)}.`,
    cooling: `${sym} is cooling off — ${Math.round(chg10 ?? 0)}% in ~10 min.`,
    bleeding: `${sym} is selling off — ${Math.round(chg10 ?? 0)}% in ~10 min.`,
    recovering: `${sym} is bouncing after a dip.`,
  };

  // ── Supporting evidence lines ──
  if (buyRatio != null) {
    const pct = Math.round(buyRatio * 100);
    if (buyRatio >= 0.62) lines.push(`Buyers control the tape — ${pct}% of recent trades are buys.`);
    else if (buyRatio <= 0.4) lines.push(`Sellers dominate — only ${pct}% of recent trades are buys.`);
    else lines.push(`Flow is balanced (${pct}% buys) — waiting for a side to commit.`);
  }

  // Position vs GEM call + peak (retrace framing, low-cap aware)
  if (i.callMcUsd && i.callMcUsd > 0) {
    const x = i.currentMcUsd / i.callMcUsd;
    const peak = i.peakMcUsd && i.peakMcUsd > 0 ? i.peakMcUsd : i.currentMcUsd;
    const off = peak > 0 ? Math.round((1 - i.currentMcUsd / peak) * 100) : 0;
    if (x >= 1.05) {
      lines.push(
        `${x.toFixed(1)}× since the GEM call (${fmtUsd(i.callMcUsd)} → ${fmtUsd(i.currentMcUsd)})`
        + (off >= 20 ? `, ${off}% below its peak — a normal low-cap retrace if flow holds.` : `.`),
      );
    } else if (x >= 0.8) {
      lines.push(`Back around the call level (${fmtUsd(i.callMcUsd)}) — holding support so far.`);
    } else {
      lines.push(`Below the call level (${(x).toFixed(2)}× of ${fmtUsd(i.callMcUsd)}) — needs buyers to reclaim it.`);
    }
  }

  // Holders trend
  const hPts = i.tape.filter((p) => p.holderCount != null && p.holderCount > 0);
  if (hPts.length >= 2) {
    const h0 = hPts[0].holderCount!;
    const h1 = hPts[hPts.length - 1].holderCount!;
    if (h1 > h0) lines.push(`Holders grew ${h0} → ${h1} while we watched — distribution is widening.`);
    else if (h1 < h0) lines.push(`Holders slipped ${h0} → ${h1} — some wallets are exiting.`);
  } else if (i.holderCount && i.holderCount > 0) {
    lines.push(`${i.holderCount} holders${i.top10Pct != null ? `, top10 hold ${Math.round(i.top10Pct)}%` : ""}.`);
  }

  // Structure note
  if (i.liqUsd != null && i.liqUsd > 0) {
    const ratio = i.currentMcUsd > 0 ? i.liqUsd / i.currentMcUsd : 0;
    if (i.liqUsd >= 10_000 && ratio >= 0.1) lines.push(`Liquidity ${fmtUsd(i.liqUsd)} — tradable size for this cap.`);
    else if (i.liqUsd < 5_000) lines.push(`Thin liquidity (${fmtUsd(i.liqUsd)}) — expect slippage on size.`);
  }

  // Conviction note
  if (i.trackedWallets >= 2) lines.push(`${i.trackedWallets} tracked wallets bought this token.`);

  // ── Mood ──
  const survivalScore = i.survival?.score ?? null;
  let mood: TokenStory["mood"];
  if (phase === "exploding" || phase === "climbing" || (survivalScore != null && survivalScore >= 70)) {
    mood = "bullish";
  } else if (phase === "bleeding" || (survivalScore != null && survivalScore < 32)) {
    mood = "bearish";
  } else {
    mood = "neutral";
  }

  return { mood, headline: phaseHeadline[phase], lines: lines.slice(0, 4) };
}
