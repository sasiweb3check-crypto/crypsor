/**
 * Token story — a short natural read of the snapshot series, with memory.
 * Research copy for the detail page. Not an order ticket.
 */
import { cautionLevel, type AgentMemory, type Fill } from "./memory";
import type { Momentum } from "./survival";

export type OtherSnap = {
  kind: "pulse" | "confirm" | "hour";
  mc: number | null;
  mcSlope: number | null;
  tapeLead: string | null;
};

export type NarrativeInput = {
  symbol: string;
  kind: "pulse" | "confirm" | "hour";
  phase: string;
  tapeLead: string | null;
  mc: number | null;
  mcSlope: number | null;
  liq: number | null;
  liqSlope: number | null;
  holders: number | null;
  holderSlope: number | null;
  quality: number | null;
  fill: { mc: Fill; liq: Fill; holders: Fill };
  other: OtherSnap | null;
  memory: AgentMemory;
  walletBuys: number;
  locked: boolean;
  survival?: number | null;
  momentum?: Momentum | null;
  prevStory?: string | null;
};

function usd(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "no print";
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${Math.round(n / 100) / 10}k`;
  return `$${Math.round(n)}`;
}

function pct(slope: number | null): string | null {
  if (slope == null || !Number.isFinite(slope)) return null;
  const p = slope * 100;
  const n = Math.abs(p) >= 1 ? p.toFixed(0) : p.toFixed(1);
  return `${p >= 0 ? "+" : ""}${n}%`;
}

function kindLabel(kind: string): string {
  if (kind === "pulse") return "10m";
  if (kind === "hour") return "1h";
  return "15m";
}

function fillLine(kind: string, fill: NarrativeInput["fill"], mem: AgentMemory): string | null {
  const bits: string[] = [];
  if (fill.mc === "missing") bits.push("there is no live market-cap");
  else if (fill.mc === "stale") bits.push("market-cap is carried from an earlier print, not this one");
  if (fill.liq === "missing") bits.push("liquidity did not land");
  else if (fill.liq === "stale") bits.push("liquidity is stale");
  if (fill.holders === "missing") bits.push("holders did not land");
  else if (fill.holders === "stale") {
    bits.push(`holders are carried (${mem.caution.missingHolders} incomplete ${kind}s in a row)`);
  }
  if (!bits.length) return null;
  return `This ${kindLabel(kind)} print is incomplete: ${bits.join("; ")}. Missing data is not a clean read.`;
}

function tapeLine(lead: string | null, mcSlope: number | null, kind: string): string {
  const label = kindLabel(kind);
  const move = pct(mcSlope);
  if (lead === "buyers" && move) return `On the ${label}, buyers still lead and MC is ${move} vs the last ${label}.`;
  if (lead === "buyers") return `On the ${label}, buyers lead, but we do not have a live slope yet.`;
  if (lead === "sellers" && move) return `Sellers have the ${label} and MC is ${move}.`;
  if (lead === "sellers") return `Sellers have the ${label}.`;
  if (lead === "two_sided") return `The ${label} tape is two-sided — nobody is in control.`;
  if (move) return `MC on the ${label} is ${move}; the tape itself is unread.`;
  return `The ${label} tape is quiet.`;
}

function otherLine(other: OtherSnap | null): string | null {
  if (!other) return null;
  const label = kindLabel(other.kind);
  const move = pct(other.mcSlope);
  const mc = usd(other.mc);
  if (other.tapeLead === "sellers") return `The last ${label} (${mc}) was sell-led${move ? ` and ${move}` : ""}.`;
  if (move) return `The last ${label} showed ${mc}, ${move}.`;
  return `The last ${label} showed ${mc}.`;
}

function memoryLine(mem: AgentMemory): string | null {
  const level = cautionLevel(mem);
  const c = mem.caution;
  const lastNote = c.notes[c.notes.length - 1];
  if (level === "blocked") {
    if (c.dumps >= 2) return `Memory is blocked after two dump prints. Last note: ${lastNote ?? "stay out until confirms go quiet"}.`;
    if (c.missingMc >= 3) return "Memory is blocked: three prints without a live market-cap.";
    if (c.disagree >= 3) return "Memory is blocked: Dex and pump have disagreed too many times to trust the number.";
    return lastNote ? `Memory is blocked. ${lastNote}` : "Memory is blocked until the next clean hour print.";
  }
  if (level === "wary") {
    const why: string[] = [];
    if (c.dumps >= 1) why.push("a remembered dump");
    if (c.missingHolders >= 2) why.push(`holders unread ${c.missingHolders} times`);
    if (c.thinQuality >= 2) why.push("thin sources");
    if (c.disagree >= 1) why.push("feeds still disagree");
    if (c.missingMc >= 1) why.push("an incomplete MC print");
    return `Still wary from ${why.join(", ") || "earlier prints"}. ${lastNote ?? "That caution holds until two clean confirms."}`;
  }
  return lastNote ? `Earlier: ${lastNote}` : null;
}

export function tellStory(i: NarrativeInput): string {
  const ticker = i.symbol.startsWith("$") ? i.symbol : `$${i.symbol}`;
  const sentences: string[] = [];
  const surv = i.survival != null ? ` Survival ${i.survival}.` : "";
  const mom = i.momentum && i.momentum !== "unread" ? ` Momentum ${i.momentum}.` : "";

  sentences.push(`${ticker} is ${usd(i.mc)} on this ${kindLabel(i.kind)} snapshot.${surv}${mom}`);
  sentences.push(tapeLine(i.tapeLead, i.mcSlope, i.kind));

  const fill = fillLine(i.kind, i.fill, i.memory);
  if (fill) sentences.push(fill);

  const other = otherLine(i.other);
  if (other) sentences.push(other);

  if (i.liq != null && i.mc != null && i.mc > 0 && i.fill.liq === "live") {
    const ratio = i.liq / i.mc;
    if (ratio < 0.08) {
      sentences.push(`Live liquidity is ${usd(i.liq)} — only ${Math.round(ratio * 100)}% of cap, so slips will be violent.`);
    }
  }

  const mem = memoryLine(i.memory);
  if (mem) sentences.push(mem);

  if (i.locked) {
    sentences.push("Already on the pass book. This is a read of how it is surviving — not a new entry call.");
  } else if (i.walletBuys >= 2 && cautionLevel(i.memory) === "clear" && i.fill.mc === "live") {
    sentences.push(`${i.walletBuys} tracked wallets are in. The gate still has to pass before it is a pass.`);
  } else {
    sentences.push("Use this as context. The next 15m / 1h print is the one that confirms or fades it.");
  }

  return sentences.filter(Boolean).join(" ");
}
