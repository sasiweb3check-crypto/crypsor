/**
 * Snapshot-level agent memory.
 *
 * Agents must not forgive a missing print or a dump on the next tick.
 * Counters ratchet up on bad evidence and decay one step on a clean print.
 * Missing data is never treated as a pass.
 */
export type Fill = "live" | "stale" | "missing";

export type Caution = {
  dumps: number;
  missingMc: number;
  missingLiq: number;
  missingHolders: number;
  disagree: number;
  thinQuality: number;
  lastDumpKind: "pulse" | "confirm" | "hour" | null;
  lastDumpAt: string | null;
  notes: string[];
};

export type KindMemory = {
  incomplete: number;
  lastAt: string | null;
  lastFill: { mc: Fill; liq: Fill; holders: Fill } | null;
};

export type AgentMemory = {
  caution: Caution;
  pulse: KindMemory;
  confirm: KindMemory;
  hour: KindMemory;
};

export type CautionLevel = "clear" | "wary" | "blocked";

export type SnapshotEvent = {
  kind: "pulse" | "confirm" | "hour";
  fill: { mc: Fill; liq: Fill; holders: Fill };
  dump: boolean;
  exodus: boolean;
  disagree: boolean;
  quality: number | null;
};

const CAP = 12;

export function emptyMemory(): AgentMemory {
  return {
    caution: {
      dumps: 0, missingMc: 0, missingLiq: 0, missingHolders: 0,
      disagree: 0, thinQuality: 0, lastDumpKind: null, lastDumpAt: null, notes: [],
    },
    pulse: { incomplete: 0, lastAt: null, lastFill: null },
    confirm: { incomplete: 0, lastAt: null, lastFill: null },
    hour: { incomplete: 0, lastAt: null, lastFill: null },
  };
}

function bump(prev: number, on: boolean): number {
  if (on) return Math.min(CAP, prev + 1);
  return Math.max(0, prev - 1);
}

function note(notes: string[], line: string): string[] {
  if (!line) return notes;
  if (notes[notes.length - 1] === line) return notes;
  return [...notes, line].slice(-12);
}

export function fillOf(live: number | null | undefined, carried: number | null | undefined): Fill {
  if (live != null && Number.isFinite(live) && live > 0) return "live";
  if (carried != null && Number.isFinite(carried) && carried > 0) return "stale";
  return "missing";
}

export function remember(prev: AgentMemory, ev: SnapshotEvent, now = new Date()): AgentMemory {
  const incomplete = ev.fill.mc !== "live" || ev.fill.liq !== "live" || ev.fill.holders !== "live";
  const caution: Caution = { ...prev.caution, notes: [...prev.caution.notes] };

  caution.missingMc = bump(caution.missingMc, ev.fill.mc !== "live");
  caution.missingLiq = bump(caution.missingLiq, ev.fill.liq !== "live");
  caution.missingHolders = bump(caution.missingHolders, ev.fill.holders !== "live");
  caution.disagree = bump(caution.disagree, ev.disagree);
  caution.thinQuality = bump(caution.thinQuality, (ev.quality ?? 100) < 40);
  caution.dumps = bump(caution.dumps, ev.dump || ev.exodus);

  if (ev.dump || ev.exodus) {
    caution.lastDumpKind = ev.kind;
    caution.lastDumpAt = now.toISOString();
  }

  if (ev.fill.mc === "missing") {
    caution.notes = note(caution.notes, `${ev.kind}: no market-cap print — we will not invent one`);
  } else if (ev.fill.mc === "stale") {
    caution.notes = note(caution.notes, `${ev.kind}: MC is carried from an earlier print (${caution.missingMc} incomplete in a row)`);
  }
  if (ev.fill.holders !== "live") {
    caution.notes = note(
      caution.notes,
      `${ev.kind}: holders did not land — missing is not a pass (${caution.missingHolders} in a row)`,
    );
  }
  if (ev.fill.liq !== "live") {
    caution.notes = note(caution.notes, `${ev.kind}: liquidity unread — book size is unknown this print`);
  }
  if (ev.disagree) {
    caution.notes = note(caution.notes, `${ev.kind}: Dex / pump / GMGN still disagree — treat the number as soft`);
  }
  if (ev.dump) {
    caution.notes = note(caution.notes, `${ev.kind}: MC dumped — stay cautious until two clean confirms`);
  }
  if (ev.exodus) {
    caution.notes = note(caution.notes, `${ev.kind}: holders left between prints — that is exit, not a dip`);
  }

  const prevKind = prev[ev.kind] ?? { incomplete: 0, lastAt: null, lastFill: null };
  const kindMem: KindMemory = {
    incomplete: bump(prevKind.incomplete, incomplete),
    lastAt: now.toISOString(),
    lastFill: ev.fill,
  };

  return {
    caution,
    pulse: ev.kind === "pulse" ? kindMem : prev.pulse,
    confirm: ev.kind === "confirm" ? kindMem : prev.confirm,
    hour: ev.kind === "hour" ? kindMem : (prev.hour ?? emptyMemory().hour),
  };
}

export function cautionLevel(m: AgentMemory): CautionLevel {
  const c = m.caution;
  if (c.dumps >= 2 || c.missingMc >= 3 || c.disagree >= 3 || c.missingHolders >= 4) return "blocked";
  if (c.dumps >= 1 || c.missingHolders >= 2 || c.thinQuality >= 2 || c.missingMc >= 1 || c.disagree >= 1) {
    return "wary";
  }
  return "clear";
}

export function parseMemory(raw: unknown): AgentMemory {
  if (!raw || typeof raw !== "object") return emptyMemory();
  const o = raw as Partial<AgentMemory>;
  const base = emptyMemory();
  return {
    caution: { ...base.caution, ...(o.caution ?? {}) },
    pulse: { ...base.pulse, ...(o.pulse ?? {}) },
    confirm: { ...base.confirm, ...(o.confirm ?? {}) },
    hour: { ...base.hour, ...(o.hour ?? {}) },
  };
}
