/**
 * Dex — desk watcher / observer / trader companion.
 * Rule-based dynamic commentary from book + runner tape. No LLM required.
 */

import type { RunnerToken } from "@/lib/runner-api";
import {
  computeBookStats,
  hitTarget,
  isOpen,
  positionMultiple,
  type TraderBook,
  type TraderPosition,
} from "@/lib/trader-book";

export type CompanionMood = "watching" | "heating" | "entry" | "celebrate" | "warn" | "idle";

export type CompanionLine = {
  mood: CompanionMood;
  text: string;
  /** Short action chip under the bubble */
  tip?: string;
};

export type CompanionContext = {
  book: TraderBook;
  feed: RunnerToken[];
  focus?: TraderPosition | null;
  justEntered?: boolean;
  justExited?: { multiple: number; symbol: string } | null;
  now?: number;
};

function liveMap(feed: RunnerToken[]): Record<number, number | null> {
  const m: Record<number, number | null> = {};
  for (const t of feed) m[t.id] = t.currentMcUsd;
  return m;
}

function pick<T>(arr: T[], seed: number): T {
  return arr[Math.abs(seed) % arr.length]!;
}

function tokenById(feed: RunnerToken[], id: number): RunnerToken | undefined {
  return feed.find(t => t.id === id);
}

/** Build one sharp line for the companion — rotates with time + book state. */
export function companionSpeak(ctx: CompanionContext): CompanionLine {
  const now = ctx.now ?? Date.now();
  const tick = Math.floor(now / 12_000); // rotate ~every 12s
  const live = liveMap(ctx.feed);
  const stats = computeBookStats(ctx.book, live);
  const open = ctx.book.positions.filter(isOpen);
  const heating = ctx.feed.filter(t => t.runner.phase === "heating");
  const entry = ctx.feed.filter(t => t.runner.phase === "entry" || t.runner.alertEligible);
  const observing = ctx.feed.filter(
    t => (t.runner.signals.snapCount ?? 0) < 5
      && (t.runner.phase === "heating" || t.runner.phase === "radar"),
  );

  // Event priority
  if (ctx.justExited) {
    const m = ctx.justExited.multiple;
    if (m >= 3) {
      return {
        mood: "celebrate",
        text: `${ctx.justExited.symbol} printed ${m.toFixed(1)}×. That's the job — bank it, don't invent a fourth act.`,
        tip: "3×+ locked",
      };
    }
    if (m >= 1.5) {
      return {
        mood: "entry",
        text: `${ctx.justExited.symbol} closed ${m.toFixed(1)}×. Fine cut. Size the next one from bankroll, not ego.`,
        tip: "Partial win",
      };
    }
    return {
      mood: "warn",
      text: `${ctx.justExited.symbol} exited ${m.toFixed(2)}×. Losses are tuition — don't revenge-click the same tape.`,
      tip: "Reset",
    };
  }

  if (ctx.justEntered && ctx.focus) {
    return {
      mood: "entry",
      text: `In on ${ctx.focus.symbol} at $${Math.round(ctx.focus.entryMcUsd).toLocaleString()}. Target ${ctx.focus.targetMultiple}×. I'm watching the snaps — you watch your size.`,
      tip: `Aim ${ctx.focus.targetMultiple}×`,
    };
  }

  // Focused position coaching
  if (ctx.focus && isOpen(ctx.focus)) {
    const t = tokenById(ctx.feed, ctx.focus.tokenId);
    const mult = positionMultiple(ctx.focus, live[ctx.focus.tokenId]);
    const target = ctx.focus.targetMultiple || 3;
    if (hitTarget(ctx.focus, live[ctx.focus.tokenId])) {
      return {
        mood: "celebrate",
        text: `${ctx.focus.symbol} is ${mult.toFixed(1)}× — target hit. Take the win or trail tight. Green that doesn't leave the book isn't green.`,
        tip: "Exit available",
      };
    }
    if (t?.runner.phase === "fading" || t?.runner.phase === "dead") {
      return {
        mood: "warn",
        text: `${ctx.focus.symbol} looks ${t.runner.phase}. Don't average down on a corpse. Exit or accept the lesson.`,
        tip: "Don't chase",
      };
    }
    if (mult < 0.7) {
      return {
        mood: "warn",
        text: `${ctx.focus.symbol} is underwater at ${mult.toFixed(2)}×. Patience ≠ stubbornness. If velocity dies, you leave.`,
        tip: "Protect stake",
      };
    }
    if (t && (t.runner.signals.snapCount ?? 0) < 5) {
      return {
        mood: "watching",
        text: `Tape on ${ctx.focus.symbol} is thin — ${t.runner.signals.snapCount ?? 0}/5 snaps. System won't call ENTRY early; neither should you FOMO size.`,
        tip: "Observe",
      };
    }
    return pick([
      {
        mood: "watching" as const,
        text: `${ctx.focus.symbol} at ${mult.toFixed(2)}× toward ${target}×. Sit on hands. Let velocity prove it.`,
        tip: "Hold thesis",
      },
      {
        mood: "heating" as const,
        text: `Still in ${ctx.focus.symbol}. I'm watching MC vs your entry — no new bags until this one speaks.`,
        tip: "One idea",
      },
    ], tick + ctx.focus.tokenId);
  }

  // Desk-wide coaching
  const hitOpen = open.find(p => hitTarget(p, live[p.tokenId]));
  if (hitOpen) {
    return {
      mood: "celebrate",
      text: `${hitOpen.symbol} crossed ${hitOpen.targetMultiple}× on your book. Don't let a runner become a round-trip.`,
      tip: "Take profit?",
    };
  }

  if (stats.openCount >= 4) {
    return {
      mood: "warn",
      text: `${stats.openCount} open bags. You're a watcher, not a collector. Cap risk — close the weakest.`,
      tip: "Too many opens",
    };
  }

  if (entry.length > 0) {
    const e = pick(entry, tick);
    const snaps = e.runner.signals.snapCount ?? 0;
    if (e.runner.alertEligible && e.runner.signals.observationReady) {
      return {
        mood: "entry",
        text: `${e.symbol} cleared observation (${snaps} snaps) — ENTRY lane is live. Size small, target 3×, ignore the chat FOMO.`,
        tip: "System ENTRY",
      };
    }
    return {
      mood: "heating",
      text: `${e.symbol} wants ENTRY energy but tape is ${snaps}/5. Wait — early is how you donate to someone else's exit.`,
      tip: "Patience",
    };
  }

  if (heating.length > 0) {
    const h = pick(heating, tick);
    const snaps = h.runner.signals.snapCount ?? 0;
    return pick([
      {
        mood: "heating" as const,
        text: `${h.symbol} heating · vel ${h.velocity.toFixed(2)}× · snaps ${snaps}/5. Watch, don't leap. Observation is the edge.`,
        tip: "Heating",
      },
      {
        mood: "watching" as const,
        text: `I like the structure on ${h.symbol}, but I don't buy stories — I buy confirmed velocity after five snaps.`,
        tip: "Observe first",
      },
    ], tick);
  }

  if (observing.length > 0) {
    const o = pick(observing, tick);
    return {
      mood: "watching",
      text: `${o.symbol} still building tape (${o.runner.signals.snapCount ?? 0}/5). Good. Bored traders click buttons; paid traders wait.`,
      tip: "Building tape",
    };
  }

  if (stats.hits3x > 0 && tick % 5 === 0) {
    return {
      mood: "celebrate",
      text: `Book has ${stats.hits3x}× at 3×+. Equity $${Math.round(stats.equity).toLocaleString()}. Protect the streak — no hero size.`,
      tip: "Keep edge",
    };
  }

  if (open.length === 0) {
    return pick([
      {
        mood: "idle" as const,
        text: "Desk is quiet. I'm watching radar. No forced entries — cash is a position.",
        tip: "Stand by",
      },
      {
        mood: "watching" as const,
        text: "Scanner's hunting early wallets. We don't copy them — we wait for the runner to prove itself.",
        tip: "Radar on",
      },
      {
        mood: "idle" as const,
        text: "Don't buy boredom. When Heating stacks five snaps and velocity holds, we talk size.",
        tip: "Rules over feels",
      },
    ], tick);
  }

  const weak = open
    .map(p => ({ p, m: positionMultiple(p, live[p.tokenId]) }))
    .sort((a, b) => a.m - b.m)[0];
  if (weak && weak.m < 0.85) {
    return {
      mood: "warn",
      text: `${weak.p.symbol} dragging at ${weak.m.toFixed(2)}×. Cut or thesis-check — hope isn't a multiple.`,
      tip: "Review loser",
    };
  }

  return pick([
    {
      mood: "watching" as const,
      text: `${stats.openCount} open · unrealized ${stats.openPnl >= 0 ? "+" : ""}$${Math.round(stats.openPnl)}. Stay patient — 3× is the north star.`,
      tip: "Book check",
    },
    {
      mood: "heating" as const,
      text: "I'm the slow trader in the room on purpose. Fast money is usually someone else's exit liquidity.",
      tip: "Slow is smooth",
    },
  ], tick + stats.openCount);
}

/** Extra one-liners when user hovers / taps companion. */
export function companionBanter(seed: number): string {
  return pick([
    "Don't ape the first green candle. Tape first.",
    "If you need a tip: never market-buy a fading phase.",
    "3× and leave. Greed writes the postmortem.",
    "Smart wallets dump. We use them as sensors, not heroes.",
    "Observation snaps exist so you don't marry a wick.",
    "Size so wrong feels boring. Right can still print.",
    "I'm watching. You're clicking. Let's not reverse those jobs.",
    "No tagged presence + no velocity = sightseeing, not trading.",
  ], seed);
}
