/**
 * Dex — animated watcher companion with live emoji news ticker.
 * Not an auto-trader — he watches and comments; you place entries/exits.
 */
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  companionBanter,
  companionNewsFeed,
  companionSpeak,
  type CompanionContext,
  type CompanionMood,
} from "@/lib/trader-companion";

const MOOD_COLOR: Record<CompanionMood, string> = {
  watching: "var(--cryp-mint)",
  heating: "var(--cryp-warn)",
  entry: "var(--cryp-teal)",
  celebrate: "var(--cryp-gain)",
  warn: "var(--cryp-loss)",
  idle: "var(--cryp-mute)",
};

export function TraderCompanion({
  ctx,
  className,
}: {
  ctx: CompanionContext;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [banter, setBanter] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 3_000);
    return () => window.clearInterval(id);
  }, []);

  const fullCtx = { ...ctx, now };
  const line = companionSpeak(fullCtx);
  const feed = companionNewsFeed(fullCtx, 7);
  const color = MOOD_COLOR[line.mood];
  const watchCount = ctx.watchlist?.length ?? 0;

  return (
    <div className={cn("desk-card p-4 md:p-5 fade-up overflow-hidden", className)}>
      <div className="flex items-start gap-3 md:gap-4">
        <button
          type="button"
          className="relative shrink-0 w-16 h-16 md:w-[72px] md:h-[72px] focus:outline-none"
          onClick={() => setBanter(companionBanter(Math.floor(now / 1000)))}
          aria-label="Talk to Dex"
          title="Tap Dex"
        >
          <div className="dex-body" style={{ borderColor: color }}>
            <div className={cn("dex-face", `dex-mood-${line.mood}`)}>
              <span className="dex-eye left" />
              <span className="dex-eye right" />
              <span className="dex-mouth" />
            </div>
            <span className="dex-hat" style={{ background: color }} />
          </div>
          <span
            className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 text-[8px] font-bold tracking-[0.2em] uppercase"
            style={{ color }}
          >
            Dex
          </span>
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-display text-[11px] font-bold tracking-[0.18em] uppercase" style={{ color }}>
              {line.emoji ?? ""} {line.mood}
            </span>
            {line.tip && (
              <span
                className="text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5"
                style={{ color: "var(--cryp-ink)", background: color }}
              >
                {line.tip}
              </span>
            )}
            <span className="text-[9px] tracking-wider uppercase text-[var(--cryp-mute)]">
              Auto-watch · not auto-trade
            </span>
            {watchCount > 0 && (
              <span
                className="text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5"
                style={{ color: "var(--cryp-mint)", background: "rgba(61,154,139,0.16)" }}
              >
                👀 {watchCount} watched
              </span>
            )}
          </div>
          <p
            key={`${line.mood}-${line.text.slice(0, 28)}-${Math.floor(now / 8_000)}`}
            className="dex-bubble mt-2 text-[13px] md:text-[14px] leading-relaxed text-[var(--cryp-text)]"
          >
            {banter ?? line.text}
          </p>
          {banter && (
            <button
              type="button"
              className="mt-2 text-[10px] tracking-widest uppercase text-[var(--cryp-mute)] hover:text-[var(--cryp-mint)]"
              onClick={() => setBanter(null)}
            >
              Back to live news
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 pt-3" style={{ borderTop: "1px solid var(--cryp-line)" }}>
        <div className="flex items-center justify-between mb-2">
          <span className="font-display text-[10px] font-bold tracking-[0.2em] uppercase text-[var(--cryp-teal)]">
            📰 Live news
          </span>
          <span className="text-[10px] text-[var(--cryp-mute)]">
            refreshes while you watch
          </span>
        </div>
        <ul className="dex-news space-y-2 max-h-[180px] overflow-y-auto no-scrollbar">
          {feed.map((n, i) => (
            <li
              key={`${n.at}-${i}-${n.text.slice(0, 20)}`}
              className="dex-news-row text-[12px] leading-snug"
              style={{
                color: i === 0 ? "var(--cryp-text)" : "var(--cryp-mute)",
                animationDelay: `${i * 0.04}s`,
              }}
            >
              <span className="mr-1.5">{n.emoji ?? "•"}</span>
              <span>{n.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
