/**
 * Omo decision engine — ported from https://github.com/omotrades/omo
 *
 *   market.server.ts  Dex tape, fake-chart filter, newborn fade, second pass
 *   audit.server.ts   one rule set for the live gate and the published refusals
 *
 * Names arrive from tracked-wallet buys (Helius) or public tape (Dex boosts,
 * pump movers, CoinGecko). Public tape never auto-locks — suggestion only.
 * A pass still needs a tracked-wallet swap. After that: read tape → gate.
 *
 * Low-cap is fine. A ~$2k market cap is already in the rug zone — we never
 * suggest those. Missing feeds fail the related rule and say so. We do not
 * invent a pass from a blank Dex or pump callback.
 */

export const LIQ_FLOOR = 15_000;
export const LIQ_FLOOR_NEWBORN = 6_000;
export const VOL1H_ALIVE = 8_000;
export const MC_SUGGEST_MIN = 8_000;
export const MC_RUG_ZONE = 5_000;
export const CHASE_6H_PCT = 250;

export const PHASES = [
  "intake",
  "ward",
  "icu",
  "recovery",
  "deceased",
  "revived",
] as const;
export type Phase = (typeof PHASES)[number];

export type TapeLead = "buyers" | "sellers" | "two_sided" | "unknown";
export type Call = "buying" | "holding" | "stalking" | "pass";
export type QualityGrade = "live" | "fallback" | "thin";

export type TapeWindow = {
  buys: number | null;
  sells: number | null;
  volUsd: number | null;
  changePct: number | null;
};

export type OmoCandidate = {
  symbol: string;
  name: string;
  mint: string;
  priceUsd: number;
  liquidityUsd: number;
  mcUsd: number;
  fdv: number;
  vol24h: number;
  vol1h: number;
  vol5m: number;
  vol6h: number;
  chg5m: number;
  chg1h: number;
  chg6h: number;
  chg24h: number;
  buys1h: number;
  sells1h: number;
  buys5m: number;
  sells5m: number;
  buys6h: number;
  sells6h: number;
  ageHours: number;
  socials: string[];
  hasSite: boolean;
  walletBuys: number;
  held: boolean;
  fakeChart: boolean;
  newbornFaded: boolean;
  source: "dex" | "pump" | "mixed";
  flags: string[];
};

export type TokenResearch = {
  symbol: string;
  mint: string;
  pools: number;
  totalLiquidityUsd: number;
  topPoolShare: number;
  vol6h: number;
  buys6h: number;
  sells6h: number;
  chg6h: number;
  socials: string[];
  hasSite: boolean;
};

export type AuditRule = {
  id: string;
  pass: boolean;
  detail: string;
};

export type Check = {
  text: string;
  hold: boolean | null;
};

export type Decision = {
  call: Call;
  rules: AuditRule[];
  refusedOn: string[];
  checks: Check[];
  tapeLead: TapeLead;
  chase: boolean;
  dead: boolean;
  tradeOk: boolean;
  quality: QualityGrade;
  qualityNote: string | null;
  thesis: string;
  score: number;
};

const RULE_LABELS: Record<string, string> = {
  livable_mc: "market cap above the rug zone",
  liquidity_floor: "pool deep enough to exit the size",
  volume_alive: "1h volume still real, not a dead tape",
  buy_pressure: "buys leading sells on the hour",
  not_newborn_fade: "not a fresh launch already bleeding",
  not_fake_chart: "tape looks like a crowd, not a manufactured chart",
  not_chase: "not chasing an already-exploded 6h rocket",
  public_presence: "named socials or a site behind the ticker",
  wallet_heat: "a tracked wallet actually bought it",
  already_held: "size already on in this name",
};

export function ruleLabel(id: string): string {
  return RULE_LABELS[id] ?? id;
}

export function emptyTape(): TapeWindow {
  return { buys: null, sells: null, volUsd: null, changePct: null };
}

export function tapeOf(buys: number | null, sells: number | null, volUsd: number | null, changePct: number | null): TapeWindow {
  return { buys, sells, volUsd, changePct };
}

/**
 * omo describeCandidate pressure: 1.15× to call a side, else nobody leading.
 * Used for the "how it decided" panel. The gate itself uses buys > sells,
 * matching audit.server.ts exactly.
 */
export function tapeLead(buys: number, sells: number): TapeLead {
  if (buys + sells < 8) return "unknown";
  if (buys > sells * 1.15) return "buyers";
  if (sells > buys * 1.15) return "sellers";
  return "two_sided";
}

export function money(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

/**
 * Manufactured charts — copied from omo market.server.ts isFakeChart.
 * A wash-traded pair never reaches omo's reasoning. We still surface it
 * so the refusal is visible, then fail `not_fake_chart`.
 */
export function isFakeChart(c: {
  vol1h: number;
  vol5m: number;
  vol6h: number;
  vol24h: number;
  buys1h: number;
  sells1h: number;
  chg1h: number;
  chg6h: number;
  chg24h: number;
  liquidityUsd: number;
  fdv: number;
  ageHours: number;
}): boolean {
  const liq = c.liquidityUsd;
  const trades = c.buys1h + c.sells1h;
  const lifeVol = c.ageHours > 0 && c.ageHours < 24 ? c.vol24h : Math.max(c.vol24h, c.vol6h * 4);
  const feesUsd = lifeVol * 0.005;
  if (c.ageHours > 0 && c.ageHours < 72 && c.fdv > 0 && feesUsd < c.fdv * 0.03) return true;
  if (c.ageHours > 0 && c.ageHours < 24 && c.fdv < 150_000 && feesUsd < 2_000) return true;
  if (liq > 0 && c.vol1h > liq * 20) return true;
  if (liq > 0 && c.vol24h > liq * 150) return true;
  if (c.vol1h > 50_000 && trades < 60) return true;
  if (trades > 0 && c.vol1h / trades > 2_500 && liq < 150_000) return true;
  if (trades > 40 && (c.buys1h === 0 || c.sells1h === 0)) return true;
  if (c.chg1h < -25 && c.chg6h < -40) return true;
  if (c.chg24h < -55 && c.chg6h < -20) return true;
  if (liq > 0 && c.vol1h < liq * 0.15 && c.vol24h < liq * 3) return true;
  if (c.vol5m === 0 && c.vol1h < 5_000) return true;
  if (c.vol24h > 0 && c.vol6h / c.vol24h < 0.06) return true;
  if (liq > 0 && c.fdv > 0 && c.fdv / liq > 30) return true;
  return false;
}

/** omo newbornFaded — a young name that already went quiet is forgotten. */
export function newbornFaded(c: {
  ageHours: number;
  vol1h: number;
  vol5m: number;
  vol24h: number;
  buys1h: number;
  sells1h: number;
}): boolean {
  if (!(c.ageHours > 0 && c.ageHours < 24)) return false;
  const trades = c.buys1h + c.sells1h;
  if (c.vol1h < 8_000) return true;
  if (c.vol5m < 500) return true;
  if (trades < 60) return true;
  if (c.vol24h > 0 && c.vol1h / c.vol24h < 0.05) return true;
  return false;
}

export function qualityOf(flags: string[], source: OmoCandidate["source"]): { grade: QualityGrade; note: string | null } {
  const missing = flags.filter((f) => f.startsWith("missing_") || f.endsWith("_down") || f === "dex_missing");
  if (source === "pump" || flags.includes("dex_missing") || flags.includes("using_pump_fallback")) {
    return {
      grade: "fallback",
      note: "DexScreener had no pair — using the pump.fun callback. Data quality is less. Missing tape is not a pass.",
    };
  }
  if (missing.length) {
    return {
      grade: "thin",
      note: `Some public feeds missed (${missing.slice(0, 3).join(", ")}). Data quality is less — unread fields are not treated as holds.`,
    };
  }
  if (source === "mixed") {
    return {
      grade: "fallback",
      note: "Dex tape plus a pump.fun callback for fields Dex did not print. Treat the filled gaps as softer.",
    };
  }
  return { grade: "live", note: null };
}

/**
 * The rule set. Same ids/thresholds as omo audit.server.ts, plus:
 *   livable_mc  — Crypsor: never suggest the ~$2k rug zone
 *   not_chase   — omo live loop refuses already-exploded 6h rockets
 *   not_fake_chart / wallet_heat — visible refusals for our discovery path
 *
 * cash_available / not_on_break / crowd_heat are omo execution/FOMO rules.
 * We do not execute and we do not have FOMO; wallet buys are the crowd read.
 */
export function evaluateRules(
  c: OmoCandidate,
  research?: TokenResearch,
): { rules: AuditRule[]; inputs: Record<string, unknown> } {
  const liquidity = research?.totalLiquidityUsd || c.liquidityUsd || 0;
  const vol1h = c.vol1h || 0;
  const buys = c.buys1h || research?.buys6h || 0;
  const sells = c.sells1h || research?.sells6h || 0;
  const chg1h = c.chg1h || 0;
  const chg6h = research?.chg6h ?? c.chg6h ?? 0;
  const ageHours = c.ageHours || 0;
  const socials = (c.socials.length ? c.socials : research?.socials) ?? [];
  const hasSite = c.hasSite || research?.hasSite || false;
  const mc = c.mcUsd || c.fdv || 0;
  const liqFloor = ageHours > 0 && ageHours < 24 ? LIQ_FLOOR_NEWBORN : LIQ_FLOOR;

  const rules: AuditRule[] = [
    {
      id: "livable_mc",
      pass: mc >= MC_SUGGEST_MIN,
      detail: mc > 0
        ? (mc < MC_RUG_ZONE
          ? `${money(mc)} MC is in the rug zone — already rugged, not a suggestion`
          : mc < MC_SUGGEST_MIN
            ? `${money(mc)} MC is below the $${MC_SUGGEST_MIN.toLocaleString("en-US")} floor`
            : `MC ${money(mc)}`)
        : "no market cap print — will not invent one",
    },
    {
      id: "liquidity_floor",
      pass: liquidity >= liqFloor,
      detail: `pool $${Math.round(liquidity).toLocaleString("en-US")}`,
    },
    {
      id: "volume_alive",
      pass: vol1h >= VOL1H_ALIVE,
      detail: vol1h > 0
        ? `1h volume $${Math.round(vol1h).toLocaleString("en-US")}`
        : "1h volume unread — will not invent a tape",
    },
    {
      id: "buy_pressure",
      pass: buys > sells && buys + sells >= 8,
      detail: buys + sells >= 8
        ? `${buys} buys vs ${sells} sells`
        : "hour tape unread — nobody to grade",
    },
    {
      id: "not_newborn_fade",
      pass: !(ageHours > 0 && ageHours < 24 && chg1h < -15) && !c.newbornFaded,
      detail: c.newbornFaded
        ? `age ${ageHours.toFixed(1)}h already quiet — forgotten rather than tracked`
        : `age ${ageHours ? `${ageHours.toFixed(1)}h` : "unknown"}, 1h ${chg1h.toFixed(1)}%`,
    },
    {
      id: "not_fake_chart",
      pass: !c.fakeChart,
      detail: c.fakeChart ? "wash / empty / corpse tape — nothing worth saying" : "tape looks tradable",
    },
    {
      id: "not_chase",
      pass: !(Number.isFinite(chg6h) && chg6h >= CHASE_6H_PCT),
      detail: `6h ${chg6h >= 0 ? "+" : ""}${chg6h.toFixed(1)}%`,
    },
    {
      id: "public_presence",
      pass: socials.length > 0 || hasSite,
      detail: socials.length ? socials.join("/") : hasSite ? "site only" : "nothing public — will not invent a story",
    },
    {
      id: "wallet_heat",
      pass: c.walletBuys >= 1,
      detail: `${c.walletBuys} tracked wallet${c.walletBuys === 1 ? "" : "s"} bought`,
    },
    {
      id: "already_held",
      pass: !c.held,
      detail: c.held ? "already on the book" : "no size on",
    },
  ];

  return {
    rules,
    inputs: {
      liquidityUsd: Math.round(liquidity),
      mcUsd: Math.round(mc),
      vol1h: Math.round(vol1h),
      vol6h: Math.round(c.vol6h || research?.vol6h || 0),
      buys1h: buys,
      sells1h: sells,
      chg1h: Number(chg1h.toFixed(2)),
      chg6h: Number(chg6h.toFixed(2)),
      ageHours: Number(ageHours.toFixed(2)),
      socials,
      hasSite,
      walletBuys: c.walletBuys,
      held: c.held,
      researched: Boolean(research),
      source: c.source,
      flags: c.flags,
    },
  };
}

/** "How it decided" — hold/fail lines omo prints next to each name. */
export function buildChecks(c: OmoCandidate, research: TokenResearch | undefined, rules: AuditRule[]): Check[] {
  const checks: Check[] = [];
  const lead = tapeLead(c.buys1h, c.sells1h);
  const age = c.ageHours >= 24
    ? `${(c.ageHours / 24).toFixed(1)}d old`
    : c.ageHours > 0 ? `${c.ageHours.toFixed(1)}h old` : null;

  if (lead === "unknown") {
    checks.push({ text: "live hour tape unread — could not be verified", hold: null });
  } else if (lead === "sellers") {
    checks.push({ text: "sellers lead the live hour", hold: false });
  } else if (lead === "two_sided") {
    checks.push({ text: "live hour is two-sided with nobody leading", hold: false });
  } else {
    checks.push({ text: "buyers still lead the live hour", hold: true });
  }

  if (c.vol1h >= VOL1H_ALIVE) {
    checks.push({
      text: `1h ${money(c.vol1h)} gives the tape enough attention to matter`,
      hold: true,
    });
  } else if (c.vol1h > 0) {
    checks.push({ text: `1h ${money(c.vol1h)} is a dead tape, not a crowd`, hold: false });
  } else {
    checks.push({ text: "1h volume unread — missing is not a pass", hold: null });
  }

  const buys6 = research?.buys6h || c.buys6h;
  const sells6 = research?.sells6h || c.sells6h;
  const chg6 = research?.chg6h ?? c.chg6h;
  const vol6 = research?.vol6h || c.vol6h;
  if (buys6 + sells6 >= 8) {
    const side = tapeLead(buys6, sells6);
    if (side === "buyers") {
      checks.push({
        text: `6h ${money(vol6)} with buyers still in front${chg6 >= CHASE_6H_PCT ? ` — but ${chg6.toFixed(0)}% is already a chase` : ""}`,
        hold: chg6 < CHASE_6H_PCT,
      });
    } else if (side === "sellers") {
      checks.push({ text: `sellers in front over the 6h (${chg6 >= 0 ? "+" : ""}${chg6.toFixed(1)}%)`, hold: false });
    } else {
      checks.push({ text: "two-sided, nobody leading over the 6h", hold: false });
    }
  } else if (c.source !== "dex") {
    checks.push({ text: "6h second pass unread — Dex had no pair to research", hold: null });
  }

  if (chg6 >= CHASE_6H_PCT) {
    checks.push({
      text: `6h +${chg6.toFixed(0)}% leaves early holders with too clean an exit`,
      hold: false,
    });
  }

  if (c.liquidityUsd >= LIQ_FLOOR) {
    checks.push({ text: `liquidity ${money(c.liquidityUsd)} holds`, hold: true });
  } else if (c.liquidityUsd > 0) {
    checks.push({ text: `pool ${money(c.liquidityUsd)} is too thin to exit cleanly`, hold: false });
  } else {
    checks.push({ text: "liquidity unread — will not invent a book", hold: null });
  }

  if (c.mcUsd > 0 && c.mcUsd < MC_SUGGEST_MIN) {
    checks.push({
      text: `${money(c.mcUsd)} MC is in the already-rugged band — not a suggestion`,
      hold: false,
    });
  }

  if (age) {
    const young = c.ageHours > 0 && c.ageHours < 24;
    checks.push({
      text: young
        ? `${age} and still printing a day-long tape`
        : `${age} gives it history, not urgency`,
      hold: young ? !c.newbornFaded && c.chg1h >= -15 : true,
    });
  }

  if (c.socials.length || c.hasSite) {
    checks.push({
      text: c.hasSite
        ? `site live${c.socials.length ? `, socials ${c.socials.join("/")}` : ""}`
        : `socials ${c.socials.join("/")} — extra surface, not a substitute for tape`,
      hold: true,
    });
  } else {
    checks.push({ text: "fomo/web blank — no outside story gets added", hold: false });
  }

  if (c.walletBuys >= 1) {
    checks.push({
      text: `${c.walletBuys} tracked wallet${c.walletBuys === 1 ? "" : "s"} bought — our only discovery source`,
      hold: true,
    });
  }

  const unread = rules.filter((r) => !r.pass && /unread|invent|nothing public|rug zone/i.test(r.detail));
  for (const r of unread.slice(0, 1)) {
    if (!checks.some((x) => x.text.includes(r.detail.slice(0, 18)))) {
      checks.push({ text: r.detail, hold: false });
    }
  }

  const seen = new Set<string>();
  return checks.filter((x) => {
    if (seen.has(x.text)) return false;
    seen.add(x.text);
    return true;
  }).slice(0, 7);
}

function thesisOf(call: Call, c: OmoCandidate, checks: Check[], refusedOn: string[]): string {
  const ticker = c.symbol.replace(/^\$/, "");
  if (call === "holding") {
    return `still on $${ticker} while liquidity holds. out if the main pool starts draining or sellers take the live hour.`;
  }
  if (call === "buying") {
    const why = checks.filter((x) => x.hold === true).slice(0, 2).map((x) => x.text).join("; ");
    return `buying $${ticker} — ${why || "tape and pool cleared the gate"}. out if liquidity leaves the main pool.`;
  }
  if (call === "stalking") {
    return `stalking $${ticker} — the pool is livable but the live hour is not clean enough to size. waiting for buyers to take control.`;
  }
  const why = refusedOn[0] || checks.find((x) => x.hold === false)?.text || "gate closed";
  return `pass $${ticker} — ${why}.`;
}

/**
 * One decision. Any failed hard rule is a refusal, same as omo's pipeline:
 * refusedOn.length === 0 is the only path to buying (and we still require
 * buyers on the hour, matching omo's live "how it decided" fails).
 */
export function decide(c: OmoCandidate, research?: TokenResearch): Decision {
  const { rules } = evaluateRules(c, research);
  const q = qualityOf(c.flags, c.source);
  const lead = tapeLead(c.buys1h, c.sells1h);
  const chase = c.chg6h >= CHASE_6H_PCT;
  const dead = (c.mcUsd > 0 && c.mcUsd < MC_RUG_ZONE)
    || (c.liquidityUsd > 0 && c.liquidityUsd < 400)
    || c.fakeChart && c.mcUsd < MC_SUGGEST_MIN;

  const failed = rules.filter((r) => !r.pass);
  const refusedOn = failed.map((r) => ruleLabel(r.id));
  const checks = buildChecks(c, research, rules);

  const hardIds = new Set([
    "livable_mc", "liquidity_floor", "volume_alive", "not_newborn_fade",
    "not_fake_chart", "not_chase", "wallet_heat",
  ]);
  const hardFail = failed.some((r) => hardIds.has(r.id));
  const buyPressure = rules.find((r) => r.id === "buy_pressure")?.pass ?? false;
  const publicOk = rules.find((r) => r.id === "public_presence")?.pass ?? false;

  let call: Call = "pass";
  if (c.held) {
    call = "holding";
  } else if (!hardFail && buyPressure && publicOk && lead === "buyers" && q.grade !== "thin") {
    call = "buying";
  } else if (!hardFail && !dead && lead !== "sellers" && !chase) {
    call = "stalking";
  }

  // Fallback / unread Dex: never promote to buying. Stalking is allowed only
  // when the livable floors still passed so we keep watching the wallet buy.
  if (call === "buying" && (q.grade === "fallback" || q.grade === "thin")) {
    call = "stalking";
  }

  const passed = failed.length;
  const score = Math.max(0, Math.min(100, Math.round(100 - passed * 12 + (lead === "buyers" ? 8 : 0))));

  return {
    call,
    rules,
    refusedOn,
    checks,
    tapeLead: lead,
    chase,
    dead,
    tradeOk: call === "buying",
    quality: q.grade,
    qualityNote: q.note,
    thesis: thesisOf(call, c, checks, refusedOn),
    score,
  };
}

export function nextPhase(current: Phase, d: Decision): Phase {
  if (d.dead && current !== "revived") return "deceased";
  if (current === "deceased") {
    return d.call === "buying" || (d.tapeLead === "buyers" && !d.dead && d.score >= 58)
      ? "revived" : "deceased";
  }
  if (current === "revived") {
    if (d.dead) return "deceased";
    if (d.tapeLead === "sellers" || d.call === "pass") return "icu";
    return "revived";
  }
  if (d.call === "holding" || d.call === "buying") return "ward";
  if (d.tapeLead === "sellers" || d.chase) return "icu";
  if (d.call === "stalking") return current === "icu" ? "recovery" : "intake";
  if (current === "icu" && d.tapeLead === "buyers") return "recovery";
  return current === "intake" ? "intake" : "ward";
}

export type Prognosis = { id: string; label: string };

export function prognosis(
  phase: Phase,
  scoreOrCall?: number | Call | null,
  fails: string[] = [],
): Prognosis {
  const call = typeof scoreOrCall === "string" ? scoreOrCall : callFromFails(fails);
  if (phase === "deceased") return { id: "dead", label: "Deceased" };
  if (fails.some((f) => /chase/i.test(f))) return { id: "late", label: "Late / chase" };
  if (call === "buying") return { id: "trade", label: "Buying" };
  if (call === "holding") return { id: "stable", label: "Holding" };
  if (call === "stalking") return { id: "admitted", label: "Stalking" };
  if (call === "pass") return { id: "observe", label: "Pass" };
  if (phase === "icu") return { id: "critical", label: "Sellers / ICU" };
  if (phase === "revived") return { id: "revived", label: "Revived" };
  if (phase === "recovery") return { id: "recovering", label: "Recovering" };
  if (phase === "intake") return { id: "admitted", label: "Just admitted" };
  if (typeof scoreOrCall === "number" && scoreOrCall >= 68) return { id: "stable", label: "Stable" };
  return { id: "observe", label: "Under observation" };
}

function callFromFails(fails: string[]): Call | null {
  if (fails.some((f) => /buying/i.test(f))) return "buying";
  return null;
}

export function failsOf(reasons: unknown): string[] {
  if (!reasons || typeof reasons !== "object") return [];
  const o = reasons as { fails?: unknown; refusedOn?: unknown };
  const fails = Array.isArray(o.fails) ? o.fails : Array.isArray(o.refusedOn) ? o.refusedOn : [];
  return fails.filter((x): x is string => typeof x === "string");
}

export function callOf(reasons: unknown): Call | null {
  if (!reasons || typeof reasons !== "object") return null;
  const c = (reasons as { call?: unknown }).call;
  return c === "buying" || c === "holding" || c === "stalking" || c === "pass" ? c : null;
}

export function describeCandidate(c: OmoCandidate): string {
  const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
  const age = c.ageHours >= 24
    ? `${(c.ageHours / 24).toFixed(1)}d old`
    : c.ageHours > 0 ? `${c.ageHours.toFixed(1)}h old` : "age unknown";
  const pressure =
    c.buys1h > c.sells1h * 1.15
      ? "buyers leading the hour"
      : c.sells1h > c.buys1h * 1.15
        ? "sellers leading the hour"
        : "two-sided hour, nobody leading";
  const extra = `${c.socials.length ? `, socials ${c.socials.join("/")}` : ", no socials"}${c.hasSite ? ", has a site" : ""}`;
  return `$${c.symbol} — MC ${money(c.mcUsd)} / liq ${money(c.liquidityUsd)}, vol 1h ${money(c.vol1h)} / 24h ${money(c.vol24h)}, ${pct(c.chg5m)} 5m ${pct(c.chg1h)} 1h ${pct(c.chg6h)} 6h, ${pressure}, ${age}${extra}, ${c.walletBuys} wallet buys, mint ${c.mint}`;
}

export function describeResearch(r: TokenResearch): string {
  const pressure6h =
    r.buys6h > r.sells6h * 1.15
      ? "buyers still in front over the 6h"
      : r.sells6h > r.buys6h * 1.15
        ? "sellers in front over the 6h"
        : "two-sided, nobody leading over the 6h";
  return `$${r.symbol}: 6h vol ${money(r.vol6h)}, ${pressure6h}, 6h ${r.chg6h >= 0 ? "+" : ""}${r.chg6h.toFixed(1)}%, ${r.socials.length ? `socials: ${r.socials.join("/")}` : "no socials listed"}, ${r.hasSite ? "has a site" : "no site"}`;
}

export function emptyCandidate(over: Partial<OmoCandidate> = {}): OmoCandidate {
  return {
    symbol: "TEST",
    name: "test",
    mint: "So11111111111111111111111111111111111111112",
    priceUsd: 0.001,
    liquidityUsd: 120_000,
    mcUsd: 25_000,
    fdv: 25_000,
    vol24h: 400_000,
    vol1h: 45_000,
    vol5m: 8_000,
    vol6h: 160_000,
    chg5m: 0.4,
    chg1h: 3.2,
    chg6h: 9.1,
    chg24h: 22,
    buys1h: 420,
    sells1h: 210,
    buys5m: 40,
    sells5m: 20,
    buys6h: 900,
    sells6h: 400,
    ageHours: 96,
    socials: ["twitter"],
    hasSite: true,
    walletBuys: 2,
    held: false,
    fakeChart: false,
    newbornFaded: false,
    source: "dex",
    flags: [],
    ...over,
  };
}
