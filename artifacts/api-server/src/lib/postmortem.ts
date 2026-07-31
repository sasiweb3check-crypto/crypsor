/**
 * postmortem.ts — Pro call postmortem for traders
 *
 * Builds a structured summary from the call freeze + latest live state +
 * recent pro_snapshots. Used by /api/pro/token/:id and the token detail UI.
 */

import type { Socials } from "./socials";

export type PostmortemSeverity =
  | "pumping"
  | "ran"
  | "holding"
  | "dumping"
  | "dead"
  | "early";

export interface ProPostmortemInput {
  calledAt: string | Date;
  calledMcUsd: number | null;
  calledIntel: number | null;
  calledKol: number;
  calledSmart: number;
  calledHv: number | null;
  calledMcGrowth: number | null;
  calledVol: number | null;
  athMultiple: number | null;
  proScore: number | null;
  survivalScore: number | null;
  qualityLabel: string | null;
  entryTier: string | null;
  hit2x: boolean;
  hit5x: boolean;
  hit10x: boolean;
  hit20x?: boolean;
  hit2xAt?: string | null;
  hit5xAt?: string | null;
  hit10xAt?: string | null;
  currentMcUsd: number | null;
  liveKol: number;
  liveSmart: number;
  liveIntel: number | null;
  liveHv: number | null;
  holderCount: number | null;
  liquidityUsd: number | null;
  runStatus: string | null;
  socials: Socials;
  kolSmartSource: string | null;
  snapshots?: Array<{
    snapshotAt: string;
    mcUsd: number | null;
    gainPct: number | null;
    athMultiple: number | null;
    kolCount: number;
    smartCount: number;
    kolDelta: number;
    smartDelta: number;
    holderVelocityScore: number | null;
    survivalScore: number | null;
    runStatus: string | null;
  }>;
}

export interface ProPostmortem {
  severity: PostmortemSeverity;
  headline: string;
  summary: string;
  entry: {
    mcUsd: number | null;
    intel: number | null;
    kol: number;
    smart: number;
    hv: number | null;
    tier: string | null;
    at: string;
  };
  now: {
    mcUsd: number | null;
    gainPct: number | null;
    athMultiple: number | null;
    kol: number;
    smart: number;
    kolDelta: number;
    smartDelta: number;
    hv: number | null;
    intel: number | null;
    holders: number | null;
    liquidityUsd: number | null;
    survival: number | null;
    proScore: number | null;
    runStatus: string | null;
  };
  milestones: Array<{ tier: number; hit: boolean; at: string | null }>;
  socials: Socials;
  kolSmartSource: string | null;
  /** What worked / failed relative to our outcome bands */
  notes: string[];
  latestSnapshots: ProPostmortemInput["snapshots"];
}

function severityFrom(run: string | null, ath: number, gain: number | null, ageH: number): PostmortemSeverity {
  const r = (run ?? "").toUpperCase();
  if (r === "DEAD" || (gain != null && gain <= -80)) return "dead";
  if (r === "PUMPING" || (gain != null && gain >= 100)) return "pumping";
  if (ath >= 2 && gain != null && gain < 0) return "ran";
  if (gain != null && gain <= -40) return "dumping";
  if (ageH < 1) return "early";
  return "holding";
}

export function buildProPostmortem(inp: ProPostmortemInput): ProPostmortem {
  const called = inp.calledMcUsd ?? 0;
  const current = inp.currentMcUsd ?? 0;
  const gainPct = called > 0 && current > 0 ? ((current - called) / called) * 100 : null;
  const ath = inp.athMultiple ?? (called > 0 && current > 0 ? current / called : 1);
  const ageH = (Date.now() - new Date(inp.calledAt).getTime()) / 3_600_000;
  const kolDelta = inp.liveKol - inp.calledKol;
  const smartDelta = inp.liveSmart - inp.calledSmart;
  const severity = severityFrom(inp.runStatus, ath, gainPct, ageH);

  const notes: string[] = [];
  if (inp.calledSmart >= 2 && inp.calledSmart <= 5) {
    notes.push("Call-time smart money in sweet band (2–5).");
  } else if (inp.calledSmart === 0) {
    notes.push("No smart money at call — historically weaker hit rate.");
  }
  if (inp.calledKol >= 1 && inp.calledKol <= 3) {
    notes.push("KOL count in productive band (1–3).");
  } else if (inp.calledKol >= 4 && inp.calledSmart < 2) {
    notes.push("High KOL with thin smart — often noisy.");
  }
  if ((inp.calledHv ?? 0) >= 90) notes.push("Holder velocity was maxed at call.");
  if (kolDelta > 0) notes.push(`+${kolDelta} KOL since call.`);
  if (smartDelta > 0) notes.push(`+${smartDelta} smart since call.`);
  if (kolDelta < 0 || smartDelta < 0) notes.push("KOL/smart counts fell vs call (exits or tag churn).");
  if (ath >= 5) notes.push(`Printed ${ath.toFixed(1)}× ATH from entry.`);
  if (severity === "dead") notes.push("Structure broken — treat as postmortem only.");
  if (!inp.socials.twitter && !inp.socials.telegram && !inp.socials.website) {
    notes.push("No socials on file — verify CA / community manually.");
  }

  const headline =
    severity === "pumping" ? "Live runner from Pro call" :
    severity === "ran" ? "Ran then cooled" :
    severity === "dumping" ? "Dumping from entry" :
    severity === "dead" ? "Dead / rug path" :
    severity === "early" ? "Fresh Pro call" :
    "Holding near entry";

  const summary = [
    `Entry ${called > 0 ? `$${called >= 1000 ? `${(called / 1000).toFixed(1)}K` : called.toFixed(0)}` : "—"}`,
    gainPct != null ? `now ${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(0)}%` : null,
    `ATH ${ath.toFixed(1)}×`,
    `K${inp.calledKol}→${inp.liveKol}`,
    `S${inp.calledSmart}→${inp.liveSmart}`,
  ].filter(Boolean).join(" · ");

  return {
    severity,
    headline,
    summary,
    entry: {
      mcUsd: inp.calledMcUsd,
      intel: inp.calledIntel,
      kol: inp.calledKol,
      smart: inp.calledSmart,
      hv: inp.calledHv,
      tier: inp.entryTier,
      at: new Date(inp.calledAt).toISOString(),
    },
    now: {
      mcUsd: inp.currentMcUsd,
      gainPct,
      athMultiple: ath,
      kol: inp.liveKol,
      smart: inp.liveSmart,
      kolDelta,
      smartDelta,
      hv: inp.liveHv,
      intel: inp.liveIntel,
      holders: inp.holderCount,
      liquidityUsd: inp.liquidityUsd,
      survival: inp.survivalScore,
      proScore: inp.proScore,
      runStatus: inp.runStatus,
    },
    milestones: [
      { tier: 2, hit: inp.hit2x, at: inp.hit2xAt ?? null },
      { tier: 5, hit: inp.hit5x, at: inp.hit5xAt ?? null },
      { tier: 10, hit: inp.hit10x, at: inp.hit10xAt ?? null },
    ],
    socials: inp.socials,
    kolSmartSource: inp.kolSmartSource,
    notes,
    latestSnapshots: inp.snapshots ?? [],
  };
}

/** @deprecated legacy composite-factor label — kept for old caller routes */
export type PostmortemLabel = "GOOD_SETUP" | "SURPRISE_SIGNAL" | "DUMP_WARNING" | "NONE";

export function derivePostmortemLabel(
  _factors: unknown,
): PostmortemLabel {
  return "NONE";
}

export const POSTMORTEM_META: Record<
  PostmortemLabel,
  { label: string; color: string; description: string }
> = {
  GOOD_SETUP: { label: "Good Setup", color: "#22c55e", description: "Legacy label" },
  SURPRISE_SIGNAL: { label: "Surprise", color: "#f59e0b", description: "Legacy label" },
  DUMP_WARNING: { label: "Dump Risk", color: "#ef4444", description: "Legacy label" },
  NONE: { label: "Neutral", color: "#6b7280", description: "See Pro postmortem" },
};

export const ACHIEVEMENT_TIERS = [2, 5, 10, 20] as const;
