/**
 * Ward scoring — adopted from omotrades-style tape reads, then adapted
 * to a wallet-buy hospital:
 *
 *   omo: who leads the live hour / 6h, two-sided vs one-sided, refuse chase
 *        on already-exploded 6h rockets, never invent a story from blank data
 *   hummingbird / pumpscan: holder concentration, bundler/sniper hold share
 *   our moat: bots judged by HOLD SHARE of supply, not participant counts
 *            drawdown ≠ death; LP pull + holder exodus = death
 *
 * Discovery is wallet-buys only. Every mint is a patient. Score is a
 * survival index 0–100 with explicit hold/fail reasons (omo "how it decided").
 */
export const PHASES = [
  "intake",
  "ward",
  "icu",
  "recovery",
  "deceased",
  "revived",
] as const;
export type Phase = (typeof PHASES)[number];

export type TapeWindow = {
  buys: number | null;
  sells: number | null;
  volUsd: number | null;
  changePct: number | null;
};

export type Reading = {
  mcUsd: number | null;
  liqUsd: number | null;
  priceUsd: number | null;
  holders: number | null;
  prevHolders: number | null;
  prevLiq: number | null;
  top10Pct: number | null;
  bundlerHoldPct: number | null;
  sniperHoldPct: number | null;
  botHoldPct: number | null;
  smartCount: number | null;
  kolCount: number | null;
  whaleHoldPct: number | null;
  m5: TapeWindow;
  h1: TapeWindow;
  h6: TapeWindow;
  admissionMc: number | null;
  walletBuys: number;
  graduated: boolean;
  scansTotal: number;
};

export type Factor = {
  id: string;
  label: string;
  points: number;
  max: number;
  hold: boolean | null; // null = insufficient data (omo: don't invent)
  reason: string;
};

export type Verdict = {
  score: number;
  factors: Factor[];
  holds: string[];
  fails: string[];
  unknowns: string[];
  tapeLead: "buyers" | "sellers" | "two_sided" | "unknown";
  chase: boolean;
  dead: boolean;
  tradeOk: boolean;
};

const DEFAULT_WEIGHTS: Record<string, number> = {
  tape: 1,
  liquidity: 1,
  holders: 1,
  structure: 1,
  conviction: 1,
  timing: 1,
};

let weights: Record<string, number> = { ...DEFAULT_WEIGHTS };

export function getWeights(): Record<string, number> {
  return { ...weights };
}

export function setWeights(next: Record<string, number>): void {
  weights = { ...DEFAULT_WEIGHTS, ...next };
  for (const k of Object.keys(weights)) {
    weights[k] = Math.min(1.4, Math.max(0.6, weights[k]));
  }
}

export function resetWeights(): void {
  weights = { ...DEFAULT_WEIGHTS };
}

export function emptyTape(): TapeWindow {
  return { buys: null, sells: null, volUsd: null, changePct: null };
}

export type Prognosis = {
  id: "admitted" | "stable" | "observe" | "critical" | "recovering" | "revived" | "dead" | "late";
  label: string;
};

export function prognosis(phase: Phase, score: number | null, fails: string[] = []): Prognosis {
  if (phase === "deceased") return { id: "dead", label: "Deceased" };
  if (fails.includes("chase")) return { id: "late", label: "Late / chase" };
  if (phase === "icu") return { id: "critical", label: "About to die" };
  if (phase === "revived") return { id: "revived", label: "Revived" };
  if (phase === "recovery") return { id: "recovering", label: "Recovering" };
  if (phase === "intake") return { id: "admitted", label: "Just admitted" };
  if (score != null && score >= 68) return { id: "stable", label: "Stable" };
  return { id: "observe", label: "Under observation" };
}

export function failsOf(reasons: unknown): string[] {
  if (!reasons || typeof reasons !== "object") return [];
  const fails = (reasons as { fails?: unknown }).fails;
  return Array.isArray(fails) ? fails.filter((x): x is string => typeof x === "string") : [];
}

function txnLead(w: TapeWindow): "buyers" | "sellers" | "two_sided" | "unknown" {
  const b = w.buys ?? 0;
  const s = w.sells ?? 0;
  if (b + s < 8) return "unknown";
  const r = b / (b + s);
  if (r >= 0.58) return "buyers";
  if (r <= 0.42) return "sellers";
  return "two_sided";
}

function scale(pts: number, w: number, max: number): number {
  return Math.max(0, Math.min(max, pts * w));
}

export function judge(r: Reading): Verdict {
  const w = weights;
  const factors: Factor[] = [];
  const holds: string[] = [];
  const fails: string[] = [];
  const unknowns: string[] = [];

  const h1Lead = txnLead(r.h1);
  const m5Lead = txnLead(r.m5);
  const h6Lead = txnLead(r.h6);
  const tapeLead = h1Lead !== "unknown" ? h1Lead : m5Lead;

  // ── Tape (omo) ── max 28
  {
    let pts = 10;
    let hold: boolean | null = null;
    let reason = "tape unread — no 1h flow yet";
    if (h1Lead === "unknown" && m5Lead === "unknown") {
      unknowns.push("tape_unread");
    } else if (h1Lead === "sellers" || (h1Lead === "unknown" && m5Lead === "sellers")) {
      pts = 2;
      hold = false;
      reason = "sellers led the live hour";
      fails.push("sell_led_tape");
    } else if (h1Lead === "two_sided") {
      pts = 9;
      hold = false;
      reason = "1h two-sided — nobody leading";
      fails.push("tape_two_sided");
    } else if (h1Lead === "buyers" || m5Lead === "buyers") {
      pts = m5Lead === "sellers" ? 16 : 22;
      hold = true;
      reason = m5Lead === "sellers"
        ? "buyers led the hour after a 5m slip"
        : "buyers led the live hour";
      holds.push(reason);
    }
    if (h6Lead === "buyers" && (r.h6.volUsd ?? 0) > 20_000) {
      pts = Math.min(28, pts + 4);
    }
    factors.push({
      id: "tape",
      label: "Tape leadership",
      points: scale(pts, w.tape, 28),
      max: 28,
      hold,
      reason,
    });
  }

  // ── Liquidity ── max 20
  {
    let pts = 8;
    let hold: boolean | null = null;
    let reason = "liquidity unread";
    if (r.liqUsd == null && !r.graduated) {
      unknowns.push("liq_unread");
      reason = "bonding — no AMM liq row yet";
    } else if (r.liqUsd != null && r.liqUsd < 400) {
      pts = 0;
      hold = false;
      reason = `LP gone / thin ($${Math.round(r.liqUsd)})`;
      fails.push("liq_dead");
    } else if (r.prevLiq != null && r.liqUsd != null && r.prevLiq > 0
      && (r.liqUsd - r.prevLiq) / r.prevLiq < -0.35) {
      pts = 4;
      hold = false;
      reason = "liquidity draining >35%";
      fails.push("liq_drain");
    } else if (r.liqUsd != null && r.liqUsd >= 8_000) {
      pts = 18;
      hold = true;
      reason = `liquidity $${Math.round(r.liqUsd).toLocaleString()} holds`;
      holds.push("liquidity intact");
    } else if (r.liqUsd != null) {
      pts = 11;
      hold = true;
      reason = `liquidity $${Math.round(r.liqUsd).toLocaleString()}`;
    }
    factors.push({
      id: "liquidity",
      label: "Liquidity",
      points: scale(pts, w.liquidity, 20),
      max: 20,
      hold,
      reason,
    });
  }

  // ── Holders ── max 20
  {
    let pts = 8;
    let hold: boolean | null = null;
    let reason = "holder count unread";
    if (r.holders == null) {
      unknowns.push("holders_unread");
    } else if (r.holders < 20) {
      pts = 3;
      hold = false;
      reason = `only ${r.holders} holders`;
      fails.push("holders_thin");
    } else if (r.prevHolders != null && r.prevHolders > 0
      && (r.holders - r.prevHolders) / r.prevHolders < -0.08) {
      pts = 2;
      hold = false;
      reason = "holders exiting";
      fails.push("holders_exiting");
    } else if (r.prevHolders != null && r.holders > r.prevHolders) {
      pts = 17;
      hold = true;
      reason = `holders ${r.prevHolders} → ${r.holders}`;
      holds.push("holder growth");
    } else {
      pts = 12;
      hold = true;
      reason = `${r.holders} holders stable`;
    }
    factors.push({
      id: "holders",
      label: "Holder behaviour",
      points: scale(pts, w.holders, 20),
      max: 20,
      hold,
      reason,
    });
  }

  // ── Structure (concentration / bots by HOLD SHARE) ── max 15
  {
    let pts = 9;
    let hold: boolean | null = null;
    let reason = "structure unread";
    const top = r.top10Pct;
    const bots = r.botHoldPct ?? 0;
    const bund = r.bundlerHoldPct ?? 0;
    if (top == null && r.bundlerHoldPct == null) {
      unknowns.push("structure_unread");
    } else if ((top ?? 0) > 55 || bund > 50 || bots > 55) {
      pts = 2;
      hold = false;
      reason = `concentrated (top10 ${top ?? "?"}%, bundlers ${bund.toFixed(0)}%)`;
      fails.push("structure_bad");
    } else if ((top ?? 100) <= 35 && bund <= 25) {
      pts = 14;
      hold = true;
      reason = `distribution ok (top10 ${top?.toFixed(0) ?? "?"}%)`;
      holds.push("clean distribution");
    } else {
      pts = 8;
      hold = true;
      reason = `top10 ${top?.toFixed(0) ?? "—"}% · bundlers ${bund.toFixed(0)}%`;
    }
    factors.push({
      id: "structure",
      label: "Holder quality",
      points: scale(pts, w.structure, 15),
      max: 15,
      hold,
      reason,
    });
  }

  // ── Conviction (tracked wallets) ── max 10
  {
    const n = r.walletBuys;
    const pts = n >= 3 ? 10 : n === 2 ? 7 : 4;
    factors.push({
      id: "conviction",
      label: "Tracked wallets",
      points: scale(pts, w.conviction, 10),
      max: 10,
      hold: n >= 1,
      reason: `${n} tracked wallet${n === 1 ? "" : "s"} bought`,
    });
    if (n >= 2) holds.push(`${n} independent wallet buys`);
  }

  // ── Timing / chase veto (omo refuse +494% 6h) ── max 7
  const gainFromAdmit = r.admissionMc && r.mcUsd && r.admissionMc > 0
    ? r.mcUsd / r.admissionMc
    : null;
  const h6Change = r.h6.changePct;
  const chase = (gainFromAdmit != null && gainFromAdmit >= 5)
    || (h6Change != null && h6Change >= 250);
  {
    let pts = 5;
    let hold: boolean | null = true;
    let reason = "not a chase";
    if (chase) {
      pts = 0;
      hold = false;
      reason = gainFromAdmit != null
        ? `${gainFromAdmit.toFixed(1)}× since admit — early holders have the sell button`
        : `6h ${h6Change?.toFixed(0)}% — refuse chase`;
      fails.push("chase");
    }
    factors.push({
      id: "timing",
      label: "Timing",
      points: scale(pts, w.timing, 7),
      max: 7,
      hold,
      reason,
    });
  }

  const dead = fails.includes("liq_dead")
    || (r.mcUsd != null && r.mcUsd < 1_200)
    || (r.holders != null && r.holders < 8);

  const score = Math.round(Math.max(0, Math.min(100, factors.reduce((s, f) => s + f.points, 0))));
  const tradeOk = !dead && !chase && score >= 68
    && holds.length >= 2
    && !fails.includes("sell_led_tape")
    && r.scansTotal >= 2;

  return { score, factors, holds, fails, unknowns, tapeLead, chase, dead, tradeOk };
}

export function nextPhase(current: Phase, v: Verdict, scans: number): Phase {
  if (v.dead && current !== "revived") return "deceased";
  if (current === "deceased") {
    return v.score >= 58 && v.tapeLead === "buyers" && !v.dead ? "revived" : "deceased";
  }
  if (current === "revived") {
    if (v.dead) return "deceased";
    if (v.score < 45 || v.fails.includes("sell_led_tape")) return "icu";
    return "revived";
  }
  const critical = v.fails.includes("holders_exiting")
    || v.fails.includes("liq_drain")
    || v.fails.includes("sell_led_tape")
    || v.score < 38;
  if (critical) return "icu";
  if (current === "icu") {
    if (v.score >= 58 && v.tapeLead === "buyers") return "recovery";
    return "icu";
  }
  if (current === "recovery") {
    if (v.score >= 62 && scans >= 1) return "ward";
    return "recovery";
  }
  if (current === "intake" && scans >= 1) return critical ? "icu" : "ward";
  return current === "intake" ? "intake" : "ward";
}
