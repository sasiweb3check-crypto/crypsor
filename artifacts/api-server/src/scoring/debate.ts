/**
 * Agent debate before a TRADE lock.
 *
 * Vitals can say the gate is open. That is not enough. Four desks vote:
 *   vitals    — tape, score, chase, death
 *   quality   — Dex / pump / GMGN agreement
 *   holders   — concentration and unread intel
 *   snapshots — pulse (2m) vs confirm (5m) must not disagree on dump
 *
 * Lock only on agreement AND a satisfying entry (MC + liq zone).
 * Otherwise the mint sits on the watchlist until they agree — or it dies.
 */
import type { CautionLevel } from "./memory";

export const ENTRY_MC_MIN = 8_000;
export const ENTRY_MC_MAX = 42_000;
export const ENTRY_LIQ_MIN = 4_000;

export type Vote = "yes" | "no" | "hold";

export type AgentVote = {
  agent: "vitals" | "quality" | "holders" | "snapshots";
  vote: Vote;
  reason: string;
};

export type DebateInput = {
  score: number;
  tradeOk: boolean;
  chase: boolean;
  dead: boolean;
  tapeLead: string;
  mcUsd: number | null;
  liqUsd: number | null;
  holders: number | null;
  top10Pct: number | null;
  botHoldPct: number | null;
  bundlerHoldPct: number | null;
  quality: number | null;
  flags: string[];
  unknowns: string[];
  walletBuys: number;
  phase: string;
  pulseMcSlope: number | null;
  confirmMcSlope: number | null;
  pulseHolderSlope: number | null;
  confirmHolderSlope: number | null;
  pulseTape: string | null;
  confirmTape: string | null;
  memoryLevel?: CautionLevel;
  memoryDumps?: number;
  memoryMissingHolders?: number;
  incompletePulse?: boolean;
  incompleteConfirm?: boolean;
};

export type DebateResult = {
  votes: AgentVote[];
  yes: number;
  no: number;
  hold: number;
  agreed: boolean;
  entryOk: boolean;
  entryWhy: string;
  action: "lock" | "watch" | "pass";
  headline: string;
};

function count(votes: AgentVote[]): { yes: number; no: number; hold: number } {
  return {
    yes: votes.filter((v) => v.vote === "yes").length,
    no: votes.filter((v) => v.vote === "no").length,
    hold: votes.filter((v) => v.vote === "hold").length,
  };
}

export function entrySatisfying(mc: number | null, liq: number | null): { ok: boolean; why: string } {
  if (mc == null || mc <= 0) return { ok: false, why: "no market cap print" };
  if (mc < ENTRY_MC_MIN) return { ok: false, why: `MC ${Math.round(mc)} is below the $${ENTRY_MC_MIN} floor — too thin to size` };
  if (mc > ENTRY_MC_MAX) return { ok: false, why: `MC ${Math.round(mc)} is above $${ENTRY_MC_MAX} — entry not satisfying, refuse chase` };
  if (liq == null || liq < ENTRY_LIQ_MIN) {
    return { ok: false, why: `liq ${liq != null ? Math.round(liq) : "—"} is under $${ENTRY_LIQ_MIN}` };
  }
  return { ok: true, why: `entry zone MC $${Math.round(mc)} / liq $${Math.round(liq)}` };
}

export function vitalsVote(i: DebateInput): AgentVote {
  if (i.dead) return { agent: "vitals", vote: "no", reason: "patient is dead — LP, dust, or holder collapse" };
  if (i.chase) return { agent: "vitals", vote: "no", reason: "already exploded — refuse chase" };
  if (i.tapeLead === "sellers") return { agent: "vitals", vote: "no", reason: "sellers lead the live tape" };
  if (i.phase === "icu") return { agent: "vitals", vote: "no", reason: "ICU — stand aside" };
  if (!i.tradeOk) {
    return {
      agent: "vitals",
      vote: i.score >= 58 ? "hold" : "no",
      reason: `gate closed (score ${i.score}, ${i.tapeLead})`,
    };
  }
  if (i.score >= 74 && i.tapeLead === "buyers" && i.walletBuys >= 2) {
    return { agent: "vitals", vote: "yes", reason: `score ${i.score}, buyers, ${i.walletBuys} wallets` };
  }
  if (i.tradeOk && i.tapeLead !== "sellers") {
    return { agent: "vitals", vote: "yes", reason: `TRADE gate open · score ${i.score}` };
  }
  return { agent: "vitals", vote: "hold", reason: "tape is mixed — wait for a clean hour" };
}

export function qualityVote(i: DebateInput): AgentVote {
  const flags = i.flags ?? [];
  if (flags.includes("missing_mc") || flags.includes("stale_mc")) {
    return { agent: "quality", vote: "no", reason: "no live market-cap this print — missing is not a pass" };
  }
  if (flags.includes("mc_disagree") || flags.includes("liq_disagree")) {
    return { agent: "quality", vote: "no", reason: "Dex / pump / GMGN disagree >25% — do not lock" };
  }
  if ((i.memoryLevel ?? "clear") === "blocked") {
    return { agent: "quality", vote: "no", reason: "memory is blocked from earlier thin or disagreeing prints" };
  }
  if ((i.quality ?? 0) < 35) return { agent: "quality", vote: "hold", reason: `quality ${i.quality ?? 0}/100 — sources too thin` };
  if ((i.memoryLevel ?? "clear") === "wary") {
    return { agent: "quality", vote: "hold", reason: "quality remembers a thin or disagreeing print — wait for two clean confirms" };
  }
  if ((i.quality ?? 100) >= 55 && !flags.includes("missing_liq") && !flags.includes("stale_liq")) {
    return { agent: "quality", vote: "yes", reason: `quality ${i.quality}/100, feeds agree` };
  }
  if ((i.quality ?? 0) >= 40) return { agent: "quality", vote: "hold", reason: `quality ${i.quality}/100 — usable, not clean` };
  return { agent: "quality", vote: "hold", reason: "quality unread — missing data is not a pass" };
}

export function holdersVote(i: DebateInput): AgentVote {
  if ((i.memoryMissingHolders ?? 0) >= 3) {
    return { agent: "holders", vote: "no", reason: `holders unread ${i.memoryMissingHolders} prints in a row — missing is not a pass` };
  }
  if (i.unknowns.includes("holders_unread") || i.holders == null) {
    return { agent: "holders", vote: "hold", reason: "holder intel missing — GMGN did not land" };
  }
  if ((i.memoryMissingHolders ?? 0) >= 2) {
    return { agent: "holders", vote: "hold", reason: "holders were missing on recent snapshots — wait for a live GMGN print" };
  }
  if (i.holders < 20) return { agent: "holders", vote: "no", reason: `only ${i.holders} holders` };
  if ((i.top10Pct ?? 0) > 55) return { agent: "holders", vote: "no", reason: `top 10 hold ${(i.top10Pct ?? 0).toFixed(0)}%` };
  if ((i.botHoldPct ?? 0) > 28) return { agent: "holders", vote: "no", reason: `bots hold ${(i.botHoldPct ?? 0).toFixed(0)}% of supply` };
  if ((i.bundlerHoldPct ?? 0) > 35) return { agent: "holders", vote: "hold", reason: `bundlers still hold ${(i.bundlerHoldPct ?? 0).toFixed(0)}%` };
  if ((i.top10Pct ?? 0) > 42) return { agent: "holders", vote: "hold", reason: `top 10 at ${(i.top10Pct ?? 0).toFixed(0)}% — concentrated` };
  return { agent: "holders", vote: "yes", reason: `${i.holders} holders, top10 ${(i.top10Pct ?? 0).toFixed(0) || "—"}%` };
}

export function snapshotsVote(i: DebateInput): AgentVote {
  const pulseDump = i.pulseMcSlope != null && i.pulseMcSlope < -0.12;
  const confirmDump = i.confirmMcSlope != null && i.confirmMcSlope < -0.18;
  const dump = pulseDump || confirmDump;
  const pulseExodus = i.pulseHolderSlope != null && i.pulseHolderSlope < -0.08;
  const confirmExodus = i.confirmHolderSlope != null && i.confirmHolderSlope < -0.1;
  const exodus = pulseExodus || confirmExodus;

  if ((i.memoryLevel ?? "clear") === "blocked" || (i.memoryDumps ?? 0) >= 2) {
    return { agent: "snapshots", vote: "no", reason: "snapshot memory is blocked — earlier dumps or missing prints still stand" };
  }
  if (dump && exodus) {
    return { agent: "snapshots", vote: "no", reason: "live slope is dumping and holders are leaving" };
  }
  if (dump) return { agent: "snapshots", vote: "no", reason: "live snapshot slope is dumping — wait for a flat print" };
  if ((i.memoryDumps ?? 0) >= 1) {
    return { agent: "snapshots", vote: "hold", reason: "remembered a dump — need two clean confirms" };
  }
  if (i.incompletePulse || i.incompleteConfirm) {
    return { agent: "snapshots", vote: "hold", reason: "a snapshot print is incomplete — we will not slope a carried number" };
  }
  if (exodus) return { agent: "snapshots", vote: "hold", reason: "holders leaving between snapshots" };
  if (i.pulseTape === "sellers" || i.confirmTape === "sellers") {
    return { agent: "snapshots", vote: "hold", reason: "a snapshot tape is sell-led" };
  }
  if (i.pulseMcSlope == null || i.confirmMcSlope == null) {
    return { agent: "snapshots", vote: "hold", reason: "need live slopes on both pulse and confirm before lock" };
  }
  const climb = i.pulseMcSlope > 0.04 && i.confirmMcSlope > -0.04;
  if (climb && i.pulseTape === "buyers" && (i.memoryLevel ?? "clear") === "clear") {
    return { agent: "snapshots", vote: "yes", reason: "pulse climbing, confirm not dumping, buyers on tape" };
  }
  return { agent: "snapshots", vote: "hold", reason: "snapshots are quiet — not a dump, not a confirm" };
}

export function debateEntry(i: DebateInput): DebateResult {
  const votes = [vitalsVote(i), qualityVote(i), holdersVote(i), snapshotsVote(i)];
  const { yes, no, hold } = count(votes);
  const entry = entrySatisfying(i.mcUsd, i.liqUsd);
  const veto = no > 0 || i.dead || i.chase;
  const agreed = yes >= 3 && !veto;
  const level = i.memoryLevel ?? "clear";
  const lockReady = agreed && entry.ok && i.tradeOk && level === "clear";

  let action: DebateResult["action"] = "pass";
  if (i.dead) action = "pass";
  else if (lockReady) action = "lock";
  else if (i.tradeOk || yes >= 2 || (i.score >= 62 && !i.chase)) action = "watch";

  const headline = action === "lock"
    ? `LOCK — ${yes} yes / ${no} no · ${entry.why}`
    : action === "watch"
      ? `WATCH — ${yes} yes / ${no} no / ${hold} hold · ${entry.ok ? "entry zone ok" : entry.why}`
      : `PASS — ${votes.find((v) => v.vote === "no")?.reason ?? "no case"}`;

  return {
    votes, yes, no, hold,
    agreed,
    entryOk: entry.ok,
    entryWhy: entry.why,
    action,
    headline,
  };
}
