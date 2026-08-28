/**
 * Cross-source quality + snapshot suggestions.
 *
 * DexScreener is the tape/MC primary for graduated pairs.
 * Pump.fun /coins/{mint} is the bonding MC/liq fallback (and a second opinion).
 * GMGN web endpoints are holder/liq/structure. Missing data is not a pass.
 */
export const LOW_CAP_MAX = 80_000;
export const MID_CAP_MAX = 400_000;

export type CapBand = "low" | "mid" | "mega";

export function capBand(mc: number | null | undefined): CapBand | null {
  if (mc == null || !Number.isFinite(mc) || mc <= 0) return null;
  if (mc < LOW_CAP_MAX) return "low";
  if (mc < MID_CAP_MAX) return "mid";
  return "mega";
}

export type SnapshotKind = "pulse" | "confirm";

/** pulse ≈ 2 min, confirm ≈ 5 min. Mega caps only confirm, slowly, unless ICU. */
export function snapshotCadenceMs(band: CapBand, phase: string, kind: SnapshotKind = "confirm"): number {
  const hot = phase === "icu" || phase === "intake";
  if (kind === "pulse") {
    if (band === "mega" && !hot) return 10 * 60_000;
    return hot ? 90_000 : 2 * 60_000;
  }
  if (band === "mega" && !hot) return 15 * 60_000;
  if (hot) return 4 * 60_000;
  if (band === "low") return 5 * 60_000;
  return 5 * 60_000;
}

export type SourceName = "dex" | "pump" | "gmgn";

export type SourceRead = {
  source: SourceName;
  ok: boolean;
  mcUsd: number | null;
  liqUsd: number | null;
  holders: number | null;
  top10Pct: number | null;
};

export function relDisagree(a: number | null, b: number | null, threshold = 0.25): boolean {
  if (a == null || b == null || a <= 0 || b <= 0) return false;
  return Math.abs(a - b) / Math.max(a, b) >= threshold;
}

export type MergedVitals = {
  mcUsd: number | null;
  liqUsd: number | null;
  holders: number | null;
  top10Pct: number | null;
  used: { mc: SourceName | null; liq: SourceName | null; holders: SourceName | null; top10: SourceName | null };
  flags: string[];
  quality: number;
};

function pick(
  reads: SourceRead[],
  field: "mcUsd" | "liqUsd" | "holders" | "top10Pct",
  order: SourceName[],
): { value: number | null; source: SourceName | null } {
  for (const name of order) {
    const r = reads.find((x) => x.source === name && x.ok);
    const v = r?.[field] ?? null;
    if (v != null && Number.isFinite(v) && v > 0) return { value: v, source: name };
  }
  return { value: null, source: null };
}

export function mergeSources(reads: SourceRead[], graduated: boolean): MergedVitals {
  const flags: string[] = [];
  const dex = reads.find((r) => r.source === "dex");
  const pump = reads.find((r) => r.source === "pump");
  const gmgn = reads.find((r) => r.source === "gmgn");

  const mcOrder: SourceName[] = graduated ? ["dex", "pump"] : ["pump", "dex"];
  const mc = pick(reads, "mcUsd", mcOrder);
  const liq = pick(reads, "liqUsd", ["dex", "gmgn", "pump"]);
  const holders = pick(reads, "holders", ["gmgn", "dex"]);
  const top10 = pick(reads, "top10Pct", ["gmgn", "dex"]);

  if (relDisagree(dex?.mcUsd ?? null, pump?.mcUsd ?? null)) flags.push("mc_disagree");
  if (relDisagree(dex?.liqUsd ?? null, gmgn?.liqUsd ?? pump?.liqUsd ?? null)) flags.push("liq_disagree");
  if (relDisagree(gmgn?.holders ?? null, dex?.holders ?? null, 0.35)) flags.push("holders_disagree");
  if (mc.value == null) flags.push("missing_mc");
  if (liq.value == null) flags.push("missing_liq");
  if (holders.value == null) flags.push("missing_holders");
  if (top10.value == null) flags.push("missing_top10");
  if (!dex?.ok) flags.push("dex_down");
  if (!pump?.ok) flags.push("pump_down");
  if (!gmgn?.ok) flags.push("gmgn_down");

  let quality = 0;
  if (dex?.ok) quality += 30;
  if (pump?.ok) quality += 25;
  if (gmgn?.ok) quality += 25;
  if (!flags.includes("mc_disagree") && mc.value != null) quality += 10;
  if (!flags.includes("liq_disagree") && liq.value != null) quality += 10;
  if (flags.includes("missing_mc")) quality -= 20;
  if (flags.includes("missing_liq")) quality -= 12;
  if (flags.includes("missing_holders")) quality -= 12;
  if (flags.includes("mc_disagree") || flags.includes("liq_disagree")) quality -= 8;

  return {
    mcUsd: mc.value,
    liqUsd: liq.value,
    holders: holders.value,
    top10Pct: top10.value,
    used: { mc: mc.source, liq: liq.source, holders: holders.source, top10: top10.source },
    flags,
    quality: Math.max(0, Math.min(100, Math.round(quality))),
  };
}

export type SuggestionSeverity = "info" | "watch" | "act";

export type Suggestion = {
  id: string;
  severity: SuggestionSeverity;
  title: string;
  body: string;
};

export type SnapshotInput = {
  band: CapBand;
  phase: string;
  score: number | null;
  prevScore: number | null;
  mc: number | null;
  prevMc: number | null;
  liq: number | null;
  prevLiq: number | null;
  holders: number | null;
  prevHolders: number | null;
  top10Pct: number | null;
  tapeLead: string | null;
  chase: boolean;
  tradeOk: boolean;
  dead: boolean;
  quality: number | null;
  flags: string[];
  walletBuys: number;
  unknowns: string[];
};

export function slope(cur: number | null, prev: number | null): number | null {
  if (cur == null || prev == null || prev <= 0 || !Number.isFinite(cur) || !Number.isFinite(prev)) {
    return null;
  }
  return (cur - prev) / prev;
}

export function snapshotSuggestions(s: SnapshotInput): Suggestion[] {
  const out: Suggestion[] = [];
  const mcS = slope(s.mc, s.prevMc);
  const liqS = slope(s.liq, s.prevLiq);
  const hS = slope(s.holders, s.prevHolders);
  const liqRatio = s.mc && s.liq && s.mc > 0 ? s.liq / s.mc : null;

  if (s.dead) {
    out.push({
      id: "dead",
      severity: "act",
      title: "Patient flatlined",
      body: "LP gone, dust MC, or holder collapse — do not chase a bounce on empty books.",
    });
  }
  if (s.tradeOk) {
    out.push({
      id: "trade",
      severity: "act",
      title: "TRADE gate is open",
      body: `Score ${s.score ?? "—"} with ${s.walletBuys} tracked wallet${s.walletBuys === 1 ? "" : "s"}. Size small; this is a ward call not a guarantee.`,
    });
  }
  if (s.chase) {
    out.push({
      id: "chase",
      severity: "watch",
      title: "Refuse chase",
      body: s.band === "low"
        ? "Low-cap already ripped. Early wallets have the sell button — wait for a reset, do not FOMO."
        : "Already exploded on the 6h or since admit. Late entries get dumped on.",
    });
  }
  if (s.phase === "icu" || s.tapeLead === "sellers") {
    out.push({
      id: "icu",
      severity: "act",
      title: "Sellers in control",
      body: "Tape is sell-led or the patient is in ICU. Stand aside until buyers take the live hour.",
    });
  }
  if (s.phase === "revived") {
    out.push({
      id: "revived",
      severity: "info",
      title: "Revived — prove it",
      body: "A tracked wallet bought a dead mint. Need two more clean scans before treating this as alive.",
    });
  }
  if ((hS ?? 0) < -0.08) {
    out.push({
      id: "holder_exodus",
      severity: "act",
      title: "Holders leaving",
      body: `Holder count dropped ${Math.abs((hS ?? 0) * 100).toFixed(0)}% between snapshots. That is exit, not a dip.`,
    });
  }
  if ((liqS ?? 0) < -0.25) {
    out.push({
      id: "liq_drain",
      severity: "act",
      title: "Liquidity draining",
      body: `Liq fell ${Math.abs((liqS ?? 0) * 100).toFixed(0)}% vs the last snapshot. Watch for LP pull.`,
    });
  }
  if ((mcS ?? 0) < -0.2) {
    out.push({
      id: "mc_bleed",
      severity: "watch",
      title: "Market cap bleeding",
      body: `${s.band === "low" ? "Low cap" : "Mid cap"} MC down ${Math.abs((mcS ?? 0) * 100).toFixed(0)}% since last snapshot.`,
    });
  }
  if ((mcS ?? 0) > 0.12 && s.tapeLead === "buyers" && !s.chase) {
    out.push({
      id: "mc_climb",
      severity: "info",
      title: s.band === "low" ? "Low-cap heat" : "Mid-cap bid",
      body: `MC +${((mcS ?? 0) * 100).toFixed(0)}% with buyers leading. Prefer adds on holds, not on green candles.`,
    });
  }
  if (liqRatio != null && liqRatio < 0.08 && (s.liq ?? 0) > 0) {
    out.push({
      id: "thin_liq",
      severity: "watch",
      title: "Thin book vs cap",
      body: `Liquidity is ${(liqRatio * 100).toFixed(0)}% of MC — slips will be violent.`,
    });
  }
  if ((s.top10Pct ?? 0) > 45) {
    out.push({
      id: "top10_risk",
      severity: "watch",
      title: "Top 10 concentrated",
      body: `Top 10 hold ${(s.top10Pct ?? 0).toFixed(0)}% of supply. One wallet can dump the tape.`,
    });
  }
  if ((s.quality ?? 100) < 40) {
    out.push({
      id: "quality_thin",
      severity: "watch",
      title: "Sources are thin",
      body: `Quality ${s.quality ?? 0}/100. ${s.flags.filter((f) => f.endsWith("_down") || f.startsWith("missing_")).slice(0, 3).join(", ") || "Cross-check failed"}. Do not size up on a single feed.`,
    });
  }
  if (s.flags.includes("mc_disagree") || s.flags.includes("liq_disagree")) {
    out.push({
      id: "disagree",
      severity: "watch",
      title: "Feeds disagree",
      body: "DexScreener and pump.fun/GMGN MC or liq differ by >25%. Treat the print as stale until the next quality pass.",
    });
  }
  if (s.unknowns.includes("holders_unread") || s.flags.includes("missing_holders")) {
    out.push({
      id: "need_holders",
      severity: "info",
      title: "Holder intel missing",
      body: "GMGN did not land. Survival score is incomplete — missing data is not a pass.",
    });
  }
  if (s.prevScore != null && s.score != null && s.score - s.prevScore <= -12) {
    out.push({
      id: "score_drop",
      severity: "watch",
      title: "Survival dropping",
      body: `Score ${s.prevScore} → ${s.score}. The ward is deteriorating, not consolidating.`,
    });
  }

  const rank: Record<SuggestionSeverity, number> = { act: 0, watch: 1, info: 2 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  const seen = new Set<string>();
  return out.filter((sugg) => {
    if (seen.has(sugg.id)) return false;
    seen.add(sugg.id);
    return true;
  }).slice(0, 6);
}
