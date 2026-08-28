/**
 * Token story — a short natural read of pulse vs confirm, with memory.
 * Written for the patient page, not for logs.
 */
import { cautionLevel, type AgentMemory, type Fill } from "./memory";

export type OtherSnap = {
  kind: "pulse" | "confirm";
  mc: number | null;
  mcSlope: number | null;
  tapeLead: string | null;
};

export type NarrativeInput = {
  symbol: string;
  kind: "pulse" | "confirm";
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

function phaseLine(phase: string): string {
  if (phase === "icu") return "This one is in ICU — sellers have the live hour, so we stand aside.";
  if (phase === "revived") return "A tracked wallet bought a mint we had called dead. That is a revival, not a clean bill.";
  if (phase === "recovery") return "Coming back from ICU. We want two quiet confirms before we trust it.";
  if (phase === "intake") return "Just admitted from a wallet buy. The first prints are still proving the tape.";
  if (phase === "deceased") return "Flatlined. A bounce on an empty book is not a trade.";
  return "On the ward — stable enough to watch, not assumed healthy.";
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
  return `This ${kind} is incomplete: ${bits.join("; ")}. Missing data is not a pass.`;
}

function tapeLine(lead: string | null, mcSlope: number | null, kind: string): string {
  const move = pct(mcSlope);
  if (lead === "buyers" && move) return `On the ${kind}, buyers still lead and MC is ${move} vs the last ${kind}.`;
  if (lead === "buyers") return `On the ${kind}, buyers lead, but we do not have a live slope yet.`;
  if (lead === "sellers" && move) return `Sellers have the ${kind} and MC is ${move}. That is not a dip to buy.`;
  if (lead === "sellers") return `Sellers have the ${kind}.`;
  if (lead === "two_sided") return `The ${kind} tape is two-sided — nobody is in control.`;
  if (move) return `MC on the ${kind} is ${move}; the tape itself is unread.`;
  return `The ${kind} tape is quiet.`;
}

function otherLine(kind: "pulse" | "confirm", other: OtherSnap | null): string | null {
  if (!other) {
    return kind === "pulse"
      ? "We do not have a confirm yet, so this is only the fast print."
      : "We do not have a pulse yet to check the last two minutes.";
  }
  const label = other.kind;
  const move = pct(other.mcSlope);
  const mc = usd(other.mc);
  if (other.tapeLead === "sellers") return `${label[0].toUpperCase()}${label.slice(1)} (${mc}) is sell-led${move ? ` and ${move}` : ""}.`;
  if (move) return `${label[0].toUpperCase()}${label.slice(1)} last showed ${mc}, ${move}.`;
  return `${label[0].toUpperCase()}${label.slice(1)} last showed ${mc}.`;
}

function memoryLine(mem: AgentMemory): string | null {
  const level = cautionLevel(mem);
  const c = mem.caution;
  if (level === "blocked") {
    if (c.dumps >= 2) return "Memory is blocked: two dump prints in a row. We will not lock until confirms go quiet.";
    if (c.missingMc >= 3) return "Memory is blocked: three prints without a live market-cap.";
    if (c.disagree >= 3) return "Memory is blocked: Dex and pump have disagreed too many times to trust the number.";
    return "Memory is blocked. Agents stay out until the next clean confirm.";
  }
  if (level === "wary") {
    const why: string[] = [];
    if (c.dumps >= 1) why.push("a remembered dump");
    if (c.missingHolders >= 2) why.push(`holders unread ${c.missingHolders} times`);
    if (c.thinQuality >= 2) why.push("thin sources");
    if (c.disagree >= 1) why.push("feeds still disagree");
    if (c.missingMc >= 1) why.push("an incomplete MC print");
    return `Agents are wary from ${why.join(", ") || "earlier prints"}. That caution holds until two clean confirms.`;
  }
  return null;
}

export function tellStory(i: NarrativeInput): string {
  const ticker = i.symbol.startsWith("$") ? i.symbol : `$${i.symbol}`;
  const kind = i.kind;
  const sentences: string[] = [];

  sentences.push(`${ticker} is ${usd(i.mc)} on this ${kind}. ${phaseLine(i.phase)}`);
  sentences.push(tapeLine(i.tapeLead, i.mcSlope, kind));

  const fill = fillLine(kind, i.fill, i.memory);
  if (fill) sentences.push(fill);

  const other = otherLine(kind, i.other);
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
    sentences.push("This mint is already locked. The story now is about the exit, not a new entry.");
  } else if (i.walletBuys >= 2 && cautionLevel(i.memory) === "clear" && i.fill.mc === "live") {
    sentences.push(`${i.walletBuys} tracked wallets are in. The book still waits for the four desks to agree before a lock.`);
  } else {
    sentences.push("Nothing here is a lock by itself — watch the next confirm.");
  }

  return sentences.filter(Boolean).join(" ");
}
