/**
 * Judging (call quality) — FOMO-style ranking, MC-agnostic.
 *
 * Paired with Confidence (pro-confidence): Judging ranks opportunity; Confidence
 * decides alert loudness. Win-rate inputs are optional — feed omits them for
 * speed; detail can pass them when ?winrate=1.
 */

export type CallQualityLabel = "elite" | "strong" | "watch" | "noise";

export type CallQualityInput = {
  walletBuys: number;
  calledKol: number;
  calledSmart: number;
  liveKol: number;
  liveSmart: number;
  holderQualityScore: number | null;
  holderVelocityScore: number | null;
  avgWalletWinRate: number | null; // 0–1
  proScore: number;
  qualityLabel: string;
  athMultiple: number;
  honeypot: boolean | null;
  /** Community takeover — original dev abandoned; often healthier for memes */
  ctoFlag?: boolean | null;
  /** Dev still holding allocation (sell pressure risk) */
  creatorClose?: boolean | null;
  /** How many tokens this creator has launched (serial farmer risk) */
  creatorCreatedCount?: number | null;
  /** Crypsor-owned holder memory (not GMGN) — avg win-rate 0–1 */
  crypsorAvgWinRate?: number | null;
  /** Count of Crypsor-labeled quality holders observed on this token */
  crypsorQualityHolders?: number | null;
  /** Sum of Crypsor weightage for observed holders on this token */
  crypsorWeightage?: number | null;
};

export type CallQualityResult = {
  score: number;
  label: CallQualityLabel;
  reasons: string[];
  taggedWallets: number;
};

export function computeCallQuality(input: CallQualityInput): CallQualityResult {
  const reasons: string[] = [];
  let score = 0;

  if (input.honeypot === true) {
    return { score: 0, label: "noise", reasons: ["Honeypot"], taggedWallets: 0 };
  }

  const wallets = Math.max(0, input.walletBuys);
  const walletPts = Math.min(wallets, 12) * 7;
  score += walletPts;
  if (wallets >= 2) reasons.push(`${wallets} tracked wallets bought`);
  if (wallets >= 4) reasons.push("Multi-buy cluster");

  const tagged = Math.max(0, input.calledKol) + Math.max(0, input.calledSmart);
  const liveTagged = Math.max(0, input.liveKol) + Math.max(0, input.liveSmart);
  const taggedPts = Math.min(tagged, 8) * 6 + Math.min(liveTagged, 8) * 2;
  score += taggedPts;
  if (tagged >= 1) reasons.push(`Tagged ${input.calledSmart} smart · ${input.calledKol} KOL`);

  const hq = input.holderQualityScore ?? 0;
  const hv = input.holderVelocityScore ?? 0;
  score += Math.min(hq, 100) * 0.18;
  score += Math.min(hv, 100) * 0.12;
  if (hq >= 55) reasons.push("Holder quality solid");

  const wr = input.avgWalletWinRate;
  if (wr != null && wr > 0) {
    score += Math.min(wr, 1) * 28;
    if (wr >= 0.45) reasons.push(`Buyers win-rate ${(wr * 100).toFixed(0)}%`);
  }

  score += Math.min(Math.max(input.proScore, 0), 100) * 0.22;
  if (input.qualityLabel === "very_good") {
    score += 8;
    reasons.push("Pro very_good");
  } else if (input.qualityLabel === "good") {
    score += 3;
  }

  // Proof of runners — reward realized ATH without requiring it for entry
  if (input.athMultiple >= 10) {
    score += 10;
    reasons.push(`${input.athMultiple.toFixed(1)}× ATH`);
  } else if (input.athMultiple >= 5) {
    score += 6;
  } else if (input.athMultiple >= 2) {
    score += 3;
  }

  // CTO / creator stats (from GMGN token_info.dev — not /security)
  // When CTO'd, ignore bad serial-creator stats — community owns the tape.
  const isCto = input.ctoFlag === true;
  if (isCto) {
    score += 12;
    reasons.push("CTO (community takeover)");
    // Creator exit is expected on CTO — treat as confirmation, not risk
    if (input.creatorClose === true) {
      score += 4;
      reasons.push("Creator exited (CTO)");
    }
  } else {
    if (input.creatorClose === true) {
      score += 3;
      reasons.push("Creator closed / exited");
    } else if (input.creatorClose === false) {
      score -= 4;
      reasons.push("Creator still holding");
    }
    const created = input.creatorCreatedCount;
    if (created != null) {
      if (created >= 50) {
        score -= 10;
        reasons.push(`Serial creator (${created} tokens)`);
      } else if (created >= 15) {
        score -= 5;
        reasons.push(`Active creator (${created} tokens)`);
      } else if (created <= 2) {
        score += 2;
      }
    }
  }

  // Crypsor wallet intel weightage (our labels / win-rate — not GMGN KOL/smart)
  const cq = input.crypsorQualityHolders ?? 0;
  const cwr = input.crypsorAvgWinRate;
  const cw = input.crypsorWeightage ?? 0;
  if (cq >= 1) {
    score += Math.min(cq, 8) * 2;
    if (cq >= 3) reasons.push(`${cq} Crypsor-quality holders`);
  }
  if (cwr != null && cwr > 0) {
    score += Math.min(cwr, 1) * 18;
    if (cwr >= 0.5) reasons.push(`Crypsor WR ${(cwr * 100).toFixed(0)}%`);
  }
  if (cw > 0) score += Math.min(cw, 20) * 0.35;

  const rounded = Math.round(Math.min(score, 100));
  let label: CallQualityLabel = "noise";
  if (rounded >= 72 && wallets >= 2 && tagged >= 1) label = "elite";
  else if (rounded >= 58 && (wallets >= 2 || tagged >= 1 || cq >= 2)) label = "strong";
  else if (rounded >= 42) label = "watch";

  if (reasons.length === 0) reasons.push("Building conviction");

  return { score: rounded, label, reasons: reasons.slice(0, 4), taggedWallets: tagged };
}
