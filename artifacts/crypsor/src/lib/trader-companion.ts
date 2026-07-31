/**
 * Dex — desk watcher / observer companion (NOT an auto-trader).
 * He never places trades. He watches tokens and keeps a live emoji news feed.
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
import type { WatchedToken } from "@/lib/trader-watchlist";

export type CompanionMood = "watching" | "heating" | "entry" | "celebrate" | "warn" | "idle";

export type CompanionLine = {
  mood: CompanionMood;
  text: string;
  tip?: string;
  emoji?: string;
  symbol?: string;
  at: number;
};

export type CompanionContext = {
  book: TraderBook;
  feed: RunnerToken[];
  watchlist?: WatchedToken[];
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

function fmtMc(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

function phaseEmoji(phase: string): string {
  if (phase === "entry") return "🚀";
  if (phase === "heating") return "🔥";
  if (phase === "fading") return "😮‍💨";
  if (phase === "dead") return "💀";
  return "👀";
}

function newsForToken(t: RunnerToken, seed: number, now: number): CompanionLine {
  const snaps = t.runner.signals.snapCount ?? 0;
  const vel = t.velocity ?? 1;
  const gain = t.gainPct ?? 0;
  const ath = t.athMultiple ?? 1;
  const phase = t.runner.phase;
  const sym = t.symbol ?? "?";
  const mc = fmtMc(t.currentMcUsd);
  const emoji = phaseEmoji(phase);
  const blockers = t.runner.blockers ?? [];
  const reasons = t.runner.reasons ?? [];

  const lines: CompanionLine[] = [];

  if (phase === "entry" && t.runner.alertEligible) {
    lines.push({
      mood: "entry",
      emoji: "🚨",
      symbol: sym,
      tip: "ENTRY LIVE",
      text: `🚨 NEWS · $${sym} cleared the tape (${snaps}/5) — ENTRY lane is HOT. Vel ${vel.toFixed(2)}× · MC ${mc}. Size small, aim 3× 🎯`,
      at: now,
    });
  } else if (phase === "entry" || (phase === "heating" && snaps < 5)) {
    lines.push({
      mood: "heating",
      emoji: "⏳",
      symbol: sym,
      tip: `${snaps}/5 snaps`,
      text: `⏳ NEWS · $${sym} wants ENTRY energy but snaps are ${snaps}/5. Don't ape the wick — Dex is still observing 👀`,
      at: now,
    });
  }

  if (phase === "heating") {
    lines.push({
      mood: "heating",
      emoji: "🔥",
      symbol: sym,
      tip: "Heating",
      text: `🔥 NEWS · $${sym} heating up · vel ${vel.toFixed(2)}× · gain ${gain >= 0 ? "+" : ""}${Math.round(gain)}% · ATH ${ath.toFixed(1)}× · MC ${mc}`,
      at: now,
    });
    lines.push({
      mood: "watching",
      emoji: "📡",
      symbol: sym,
      tip: "Watching",
      text: `📡 UPDATE · $${sym} on my board. ${reasons[0] ?? "Momentum building"}. ${snaps < 5 ? `Tape ${snaps}/5 — patience 🧘‍♂️` : "Tape ready — wait for clean velocity ✅"}`,
      at: now,
    });
  }

  if (phase === "radar") {
    lines.push({
      mood: "watching",
      emoji: "👀",
      symbol: sym,
      tip: "Radar",
      text: `👀 NEWS · $${sym} on radar · MC ${mc} · intel ${t.calledIntel ?? "—"} · ${t.calledSmart}S/${t.calledKol}K. No FOMO yet 🧊`,
      at: now,
    });
  }

  if (phase === "fading") {
    lines.push({
      mood: "warn",
      emoji: "😮‍💨",
      symbol: sym,
      tip: "Fading",
      text: `😮‍💨 NEWS · $${sym} fading · vel ${vel.toFixed(2)}× · gain ${Math.round(gain)}%. Don't catch this knife 🗡️`,
      at: now,
    });
  }

  if (phase === "dead") {
    lines.push({
      mood: "warn",
      emoji: "💀",
      symbol: sym,
      tip: "Dead",
      text: `💀 NEWS · $${sym} looks dead on the desk. Tourist bags only — skip 🚫`,
      at: now,
    });
  }

  if (gain >= 100) {
    lines.push({
      mood: "celebrate",
      emoji: "💎",
      symbol: sym,
      tip: "Runner",
      text: `💎 NEWS · $${sym} already +${Math.round(gain)}% from call. Late chase = exit liquidity for early wallets ⚠️`,
      at: now,
    });
  }

  if (blockers[0]) {
    lines.push({
      mood: "warn",
      emoji: "🛑",
      symbol: sym,
      tip: "Hold up",
      text: `🛑 DEX TIP · $${sym}: ${blockers[0]}. Don't force the entry 🙅`,
      at: now,
    });
  }

  if (lines.length === 0) {
    lines.push({
      mood: "watching",
      emoji,
      symbol: sym,
      tip: "Watching",
      text: `${emoji} NEWS · Still watching $${sym} · MC ${mc} · vel ${vel.toFixed(2)}× · snaps ${snaps}/5`,
      at: now,
    });
  }

  return pick(lines, seed + t.id);
}

/** Headline bubble — rotates; prefers watchlist + open book. */
export function companionSpeak(ctx: CompanionContext): CompanionLine {
  const now = ctx.now ?? Date.now();
  const tick = Math.floor(now / 8_000);
  const live = liveMap(ctx.feed);
  const stats = computeBookStats(ctx.book, live);
  const open = ctx.book.positions.filter(isOpen);
  const watchIds = new Set((ctx.watchlist ?? []).map(w => w.tokenId));

  if (ctx.justExited) {
    const m = ctx.justExited.multiple;
    if (m >= 3) {
      return {
        mood: "celebrate",
        emoji: "🥳",
        tip: "3×+ BANKED",
        text: `🥳 BOOM · $${ctx.justExited.symbol} printed ${m.toFixed(1)}×! That's the job — bank it, don't invent act 4 💰`,
        at: now,
      };
    }
    if (m >= 1.5) {
      return {
        mood: "entry",
        emoji: "✅",
        tip: "Solid cut",
        text: `✅ CLOSED · $${ctx.justExited.symbol} at ${m.toFixed(1)}×. Fine work. Reload from bankroll, not ego 🧠`,
        at: now,
      };
    }
    return {
      mood: "warn",
      emoji: "📉",
      tip: "Lesson",
      text: `📉 EXIT · $${ctx.justExited.symbol} at ${m.toFixed(2)}×. Tuition paid — no revenge clicks 🧘`,
      at: now,
    };
  }

  if (ctx.justEntered && ctx.focus) {
    return {
      mood: "entry",
      emoji: "🎯",
      tip: `Aim ${ctx.focus.targetMultiple}×`,
      symbol: ctx.focus.symbol,
      text: `🎯 IN · $${ctx.focus.symbol} @ ${fmtMc(ctx.focus.entryMcUsd)}. Target ${ctx.focus.targetMultiple}×. I'll keep the news rolling — you manage size 💪`,
      at: now,
    };
  }

  if (ctx.focus && isOpen(ctx.focus)) {
    const t = tokenById(ctx.feed, ctx.focus.tokenId);
    const mult = positionMultiple(ctx.focus, live[ctx.focus.tokenId]);
    if (hitTarget(ctx.focus, live[ctx.focus.tokenId])) {
      return {
        mood: "celebrate",
        emoji: "🏁",
        tip: "Target hit",
        symbol: ctx.focus.symbol,
        text: `🏁 ALERT · $${ctx.focus.symbol} is ${mult.toFixed(1)}× — TARGET HIT! Take the win or trail tight 💸`,
        at: now,
      };
    }
    if (t) return newsForToken(t, tick, now);
    return {
      mood: "watching",
      emoji: "📡",
      tip: "Holding",
      symbol: ctx.focus.symbol,
      text: `📡 BOOK · $${ctx.focus.symbol} at ${mult.toFixed(2)}× toward ${ctx.focus.targetMultiple}×. Sitting on hands ✋`,
      at: now,
    };
  }

  // Watched tokens — Dex keeps commenting
  const watchedLive = (ctx.watchlist ?? [])
    .map(w => tokenById(ctx.feed, w.tokenId))
    .filter((t): t is RunnerToken => !!t);
  if (watchedLive.length > 0) {
    const t = pick(watchedLive, tick);
    return newsForToken(t, tick + 3, now);
  }

  const hitOpen = open.find(p => hitTarget(p, live[p.tokenId]));
  if (hitOpen) {
    return {
      mood: "celebrate",
      emoji: "🎉",
      tip: "Take profit?",
      symbol: hitOpen.symbol,
      text: `🎉 BOOK NEWS · $${hitOpen.symbol} crossed ${hitOpen.targetMultiple}×. Don't let a runner become a round-trip 🔄`,
      at: now,
    };
  }

  if (stats.openCount >= 4) {
    return {
      mood: "warn",
      emoji: "⚠️",
      tip: "Too many opens",
      text: `⚠️ RISK · ${stats.openCount} open bags. You're a watcher, not a collector. Cut the weakest ✂️`,
      at: now,
    };
  }

  // Auto desk watch — heating / entry / thin-tape
  const deskNews = ctx.feed.filter(
    t => t.runner.phase === "entry" || t.runner.phase === "heating"
      || ((t.runner.signals.snapCount ?? 0) < 5 && t.runner.phase === "radar"),
  );
  if (deskNews.length > 0) {
    const t = pick(deskNews, tick);
    return newsForToken(t, tick, now);
  }

  if (open.length > 0) {
    const p = pick(open, tick);
    const mult = positionMultiple(p, live[p.tokenId]);
    return {
      mood: "watching",
      emoji: "📊",
      tip: "Book check",
      symbol: p.symbol,
      text: `📊 BOOK · $${p.symbol} ${mult.toFixed(2)}× · open P&L ${stats.openPnl >= 0 ? "+" : ""}$${Math.round(stats.openPnl)} · equity $${Math.round(stats.equity).toLocaleString()} 💼`,
      at: now,
    };
  }

  if (watchIds.size === 0) {
    return pick([
      {
        mood: "idle" as const,
        emoji: "🧘",
        tip: "Stand by",
        text: "🧘 Desk quiet. Hit Watch on any token and I'll keep the emoji news rolling 📰 — I don't auto-trade, I auto-watch.",
        at: now,
      },
      {
        mood: "watching" as const,
        emoji: "📡",
        tip: "Radar on",
        text: "📡 Scanning early wallets… we don't copy them. We wait for 5 snaps + velocity 🔥",
        at: now,
      },
      {
        mood: "idle" as const,
        emoji: "🧊",
        tip: "Cash is a position",
        text: "🧊 No forced entries. Bored traders click. Dex waits for Heating with a full tape ✅",
        at: now,
      },
    ], tick);
  }

  return {
    mood: "watching",
    emoji: "👀",
    tip: "Watching",
    text: `👀 ${watchIds.size} on my watchlist — feed lagging a sec. Still here, still talking 🗣️`,
    at: now,
  };
}

/** Rolling news ticker lines for watched + open + hot desk tokens. */
export function companionNewsFeed(ctx: CompanionContext, limit = 8): CompanionLine[] {
  const now = ctx.now ?? Date.now();
  const tick = Math.floor(now / 6_000);
  const out: CompanionLine[] = [];
  const seen = new Set<string>();

  const push = (line: CompanionLine) => {
    const key = `${line.symbol ?? ""}:${line.text.slice(0, 40)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(line);
  };

  // Headline first
  push(companionSpeak(ctx));

  const watched = (ctx.watchlist ?? [])
    .map(w => tokenById(ctx.feed, w.tokenId))
    .filter((t): t is RunnerToken => !!t);

  watched.forEach((t, i) => push(newsForToken(t, tick + i * 7, now - i * 1_000)));

  for (const p of ctx.book.positions.filter(isOpen).slice(0, 4)) {
    const t = tokenById(ctx.feed, p.tokenId);
    if (t) {
      const mult = positionMultiple(p, t.currentMcUsd);
      push({
        mood: hitTarget(p, t.currentMcUsd) ? "celebrate" : "watching",
        emoji: hitTarget(p, t.currentMcUsd) ? "🏁" : "📌",
        tip: isOpen(p) ? `${mult.toFixed(2)}×` : "Closed",
        symbol: p.symbol,
        text: hitTarget(p, t.currentMcUsd)
          ? `🏁 BOOK · $${p.symbol} HIT ${p.targetMultiple}× target (${mult.toFixed(1)}× live) — exit time? 💰`
          : `📌 BOOK · Holding $${p.symbol} @ ${fmtMc(p.entryMcUsd)} → now ${fmtMc(t.currentMcUsd)} · ${mult.toFixed(2)}× toward ${p.targetMultiple}×`,
        at: now,
      });
    }
  }

  const hot = ctx.feed
    .filter(t => t.runner.phase === "entry" || t.runner.phase === "heating")
    .slice(0, 6);
  hot.forEach((t, i) => push(newsForToken(t, tick + 11 + i, now)));

  return out.slice(0, limit);
}

export function companionBanter(seed: number): string {
  return pick([
    "🗣️ Reminder: I comment — YOU click. I'm not an auto-trader 🤖❌",
    "🔥 Tip: never market-buy a fading phase. That's how bags get heavy 🎒",
    "🎯 3× and leave. Greed writes the postmortem 📝",
    "👀 Smart wallets dump. Sensors, not heroes 🛰️",
    "⏳ 5 snaps exist so you don't marry a wick 🕯️",
    "🧘 Size so a wrong trade feels boring. Right can still print 💵",
    "📰 Hit Watch and I'll spam the news (with love + emojis)",
    "🛑 No tagged presence + no velocity = sightseeing, not trading 🎟️",
  ], seed);
}
