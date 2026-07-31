/**
 * Dex — animated desk companion (watcher / observer / trader).
 */
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  companionBanter,
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
    const id = window.setInterval(() => setNow(Date.now()), 4_000);
    return () => window.clearInterval(id);
  }, []);

  const line = companionSpeak({ ...ctx, now });
  const color = MOOD_COLOR[line.mood];

  return (
    <div className={cn("desk-card p-4 md:p-5 fade-up", className)}>
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
              {line.mood}
            </span>
            {line.tip && (
              <span
                className="text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5"
                style={{ color: "var(--cryp-ink)", background: color }}
              >
                {line.tip}
              </span>
            )}
          </div>
          <p
            key={`${line.mood}-${line.text.slice(0, 24)}-${Math.floor(now / 12_000)}`}
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
              Back to desk read
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
