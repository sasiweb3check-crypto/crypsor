/**
 * Crypsor Runner Desk — radar → heating → entry.
 * Early bot-wallet universe enriched with momentum; ENTRY is the paid signal.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Copy, ExternalLink, Twitter, Send, Globe,
  Radio, Zap, Flame, Eye,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  cn, truncateAddress, formatCompactUsd, formatTimeAgo, formatCalledAt,
  getGmgnUrl, safeSymbol, safeImageUrl, parseApiDate,
} from "@/lib/utils";
import {
  fetchRunnerFeed, fetchRunnerStats,
  RUNNER_FEED_KEY, RUNNER_STATS_KEY,
  type RunnerPhase, type RunnerToken,
} from "@/lib/runner-api";

type PhaseTab = "all" | RunnerPhase;
type AgeTab = "all" | "1h" | "6h" | "24h" | "7d";

const PHASE_STYLE: Record<RunnerPhase, { color: string; bg: string; label: string }> = {
  entry:   { color: "var(--cryp-ink)", bg: "var(--cryp-gain)", label: "Entry" },
  heating: { color: "var(--cryp-warn)", bg: "rgba(212,160,23,0.18)", label: "Heating" },
  radar:   { color: "var(--cryp-mint)", bg: "rgba(61,154,139,0.16)", label: "Radar" },
  fading:  { color: "var(--cryp-mute)", bg: "rgba(122,143,153,0.14)", label: "Fading" },
  dead:    { color: "var(--cryp-loss)", bg: "rgba(232,93,93,0.14)", label: "Dead" },
};

function DeskSkeleton() {
  return (
    <div className="desk-card p-4 md:p-5 shimmer-card">
      <div className="flex items-start gap-3">
        <div className="shimmer w-11 h-11 shrink-0" />
        <div className="flex-1 space-y-2.5">
          <div className="shimmer h-4 w-28" />
          <div className="shimmer h-3 w-48 max-w-full" />
          <div className="grid grid-cols-4 gap-2 pt-1">
            {[0, 1, 2, 3].map(i => <div key={i} className="shimmer h-8" />)}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatTile({
  label, value, hint, accent,
}: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <div className="desk-card px-4 py-3.5 fade-up">
      <div className="text-[10px] tracking-[0.18em] uppercase text-[var(--cryp-mute)]">{label}</div>
      <div
        className="font-display font-mono-num text-2xl font-bold mt-1.5 tracking-tight"
        style={{ color: accent ?? "var(--cryp-text)" }}
      >
        {value}
      </div>
      {hint && <div className="text-[11px] text-[var(--cryp-mute)] mt-1">{hint}</div>}
    </div>
  );
}

function TokenCard({ t, onOpen }: { t: RunnerToken; onOpen: () => void }) {
  const { toast } = useToast();
  const [imgBroken, setImgBroken] = useState(false);
  const imgSrc = safeImageUrl(t.logoUri, t.address, t.symbol);
  const phase = PHASE_STYLE[t.runner.phase] ?? PHASE_STYLE.radar;
  const gain = t.gainPct ?? 0;
  const ath = t.athMultiple ?? 1;

  return (
    <article
      className="desk-card group cursor-pointer overflow-hidden transition-transform duration-200 hover:-translate-y-0.5 fade-up"
      onClick={onOpen}
    >
      <div className="p-4 md:p-5">
        <div className="flex items-start gap-3">
          {!imgBroken ? (
            <img
              src={imgSrc}
              alt=""
              className="w-11 h-11 object-cover shrink-0"
              style={{ background: "var(--cryp-elevated)" }}
              onError={() => setImgBroken(true)}
            />
          ) : (
            <div
              className="w-11 h-11 shrink-0 flex items-center justify-center text-[11px] font-bold"
              style={{ background: "rgba(61,154,139,0.15)", color: "var(--cryp-mint)" }}
            >
              {(safeSymbol(t.symbol, t.address) || "?").slice(0, 2)}
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-display text-[15px] font-bold truncate">
                {safeSymbol(t.symbol, t.address) || "—"}
              </h3>
              <span
                className="text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5"
                style={{ color: phase.color, background: phase.bg }}
                title={(t.runner.reasons ?? []).join(" · ")}
              >
                {phase.label} {t.runner.score}
              </span>
              {t.runnerAlertSentAt && (
                <span
                  className="text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5"
                  style={{ color: "var(--cryp-ink)", background: "var(--cryp-teal)" }}
                >
                  Pinged
                </span>
              )}
              {t.hit2x && <span className="text-[9px] font-bold text-[var(--cryp-gain)]">2×</span>}
              {t.hit5x && <span className="text-[9px] font-bold text-[var(--cryp-gain)]">5×</span>}
              {t.hit10x && <span className="text-[9px] font-bold text-[var(--cryp-mint)]">10×</span>}
            </div>
            <div className="flex items-center gap-2 mt-1 text-[11px] text-[var(--cryp-mute)]">
              <span className="font-mono-num">{formatCalledAt(t.calledAt)}</span>
              <span>·</span>
              <span>{t.runner.sizeLabel}</span>
              <span>·</span>
              <span className="font-mono-num">{truncateAddress(t.address)}</span>
            </div>
          </div>

          <button
            type="button"
            className="p-1.5 text-[var(--cryp-mute)] hover:text-[var(--cryp-mint)]"
            onClick={e => {
              e.stopPropagation();
              void navigator.clipboard.writeText(t.address);
              toast({ title: "Copied CA" });
            }}
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="grid grid-cols-4 gap-2 mt-3.5">
          {[
            { label: "Vel", value: `${(t.velocity ?? 1).toFixed(2)}×`, color: (t.velocity ?? 1) >= 1.2 ? "var(--cryp-gain)" : undefined },
            { label: "Gain", value: `${gain >= 0 ? "+" : ""}${Math.round(gain)}%`, color: gain >= 0 ? "var(--cryp-gain)" : "var(--cryp-loss)" },
            { label: "ATH", value: `${ath.toFixed(1)}×`, color: ath >= 2 ? "var(--cryp-gain)" : undefined },
            { label: "Entry", value: formatCompactUsd(t.calledMcUsd) },
          ].map(m => (
            <div key={m.label}>
              <div className="text-[9px] tracking-wider uppercase text-[var(--cryp-mute)]">{m.label}</div>
              <div className="font-mono-num text-[13px] font-semibold mt-0.5" style={{ color: m.color ?? "var(--cryp-text)" }}>
                {m.value}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-3 pt-3 flex items-center justify-between gap-2" style={{ borderTop: "1px solid var(--cryp-line)" }}>
          <div className="text-[11px] text-[var(--cryp-mute)] truncate">
            {(t.runner.reasons?.length ? t.runner.reasons.slice(0, 2).join(" · ") : "Watching momentum")}
            {t.calledSmart || t.calledKol ? ` · ${t.calledSmart}S/${t.calledKol}K` : ""}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {t.socials?.twitter && (
              <a href={t.socials.twitter} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="p-1 text-[var(--cryp-mute)] hover:text-[var(--cryp-mint)]">
                <Twitter className="w-3.5 h-3.5" />
              </a>
            )}
            {t.socials?.telegram && (
              <a href={t.socials.telegram} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="p-1 text-[var(--cryp-mute)] hover:text-[var(--cryp-mint)]">
                <Send className="w-3.5 h-3.5" />
              </a>
            )}
            {t.socials?.website && (
              <a href={t.socials.website} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="p-1 text-[var(--cryp-mute)] hover:text-[var(--cryp-mint)]">
                <Globe className="w-3.5 h-3.5" />
              </a>
            )}
            <a href={getGmgnUrl(t.chain || "solana", t.address)} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="p-1 text-[var(--cryp-mute)] hover:text-[var(--cryp-mint)]">
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>
      </div>
    </article>
  );
}

export default function Caller() {
  const [, setLocation] = useLocation();
  const [phase, setPhase] = useState<PhaseTab>("all");
  const [age, setAge] = useState<AgeTab>("7d");
  const [q, setQ] = useState("");

  const { data: stats } = useQuery({
    queryKey: RUNNER_STATS_KEY,
    queryFn: fetchRunnerStats,
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
  });

  const { data: feed, isLoading, isFetching, isPlaceholderData } = useQuery({
    queryKey: RUNNER_FEED_KEY,
    queryFn: () => fetchRunnerFeed(220),
    refetchInterval: 10_000,
    staleTime: 6_000,
    placeholderData: keepPreviousData,
  });

  const showSkeleton = isLoading && !feed;

  const phaseCounts = useMemo(() => {
    const list = feed?.tokens ?? [];
    const c: Record<PhaseTab, number> = {
      all: list.length, entry: 0, heating: 0, radar: 0, fading: 0, dead: 0,
    };
    for (const t of list) c[t.runner.phase] = (c[t.runner.phase] ?? 0) + 1;
    return c;
  }, [feed]);

  const tokens = useMemo(() => {
    let list = feed?.tokens ?? [];
    if (phase !== "all") list = list.filter(t => t.runner.phase === phase);
    const now = Date.now();
    const ageMs: Record<AgeTab, number | null> = {
      all: null, "1h": 3_600_000, "6h": 6 * 3_600_000, "24h": 24 * 3_600_000, "7d": 7 * 24 * 3_600_000,
    };
    const cut = ageMs[age];
    if (cut != null) {
      list = list.filter(t => {
        const d = parseApiDate(t.calledAt);
        return d != null && now - d.getTime() <= cut;
      });
    }
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      list = list.filter(t =>
        (t.symbol ?? "").toLowerCase().includes(s)
        || (t.name ?? "").toLowerCase().includes(s)
        || t.address.toLowerCase().includes(s),
      );
    }
    return list;
  }, [feed, phase, age, q]);

  const latest = feed?.tokens?.[0];

  return (
    <div className="px-4 md:px-8 pt-5 md:pt-8 space-y-6">
      <header className="fade-up">
        <div className="flex items-center gap-2">
          <div className="font-display text-[11px] tracking-[0.28em] uppercase text-[var(--cryp-teal)]">
            Crypsor Runner
          </div>
          {isFetching && feed && (
            <span className="inline-flex items-center gap-1 text-[10px] text-[var(--cryp-mute)]">
              <Radio className="w-3 h-3 pulse-dot" />
              syncing
            </span>
          )}
        </div>
        <h1 className="font-display text-3xl md:text-4xl font-extrabold tracking-tight mt-1.5">
          Daily runners
        </h1>
        <p className="text-[var(--cryp-mute)] text-sm mt-2 max-w-2xl leading-relaxed">
          Early wallet radar → momentum enrichment → <span className="text-[var(--cryp-text)]">ENTRY</span> when velocity confirms.
          No MC sweet-spot dump. Tagged smart <em>or</em> KOL is enough.
          {latest?.symbol && (
            <span className="text-[var(--cryp-text)]">
              {" "}Latest · {safeSymbol(latest.symbol, latest.address)}
              {latest.calledAt ? ` · ${formatTimeAgo(latest.calledAt)} ago` : ""}
            </span>
          )}
        </p>
      </header>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 fade-up fade-up-delay-1">
        {showSkeleton ? (
          [0, 1, 2, 3].map(i => (
            <div key={i} className="desk-card px-4 py-3.5 space-y-2">
              <div className="shimmer h-3 w-16" /><div className="shimmer h-7 w-14" /><div className="shimmer h-3 w-24" />
            </div>
          ))
        ) : (
          <>
            <StatTile
              label="Entry pings"
              value={String(stats?.entriesSent ?? 0)}
              hint={`${stats?.liveEntry ?? 0} live entry · ${stats?.liveHeating ?? 0} heating`}
              accent="var(--cryp-mint)"
            />
            <StatTile
              label="Ping ≥2×"
              value={stats ? `${stats.entryWinRate2x}%` : "—"}
              hint={stats ? `${stats.x2Count} printed` : undefined}
              accent="var(--cryp-gain)"
            />
            <StatTile
              label="Ping ≥10×"
              value={stats ? `${stats.entryWinRate10x}%` : "—"}
              hint={stats ? `${stats.x10Count} runners` : "daily runner rate"}
              accent="var(--cryp-gain)"
            />
            <StatTile
              label="On desk"
              value={String(stats?.desk ?? "—")}
              hint={`Best ${stats?.bestAth != null ? `${Number(stats.bestAth).toFixed(1)}×` : "—"}`}
            />
          </>
        )}
      </section>

      <section className="flex flex-col gap-3 fade-up fade-up-delay-2">
        <div className="flex flex-wrap gap-1">
          {([
            ["all", "All", Eye],
            ["entry", "Entry", Zap],
            ["heating", "Heating", Flame],
            ["radar", "Radar", Radio],
            ["fading", "Fading", Eye],
          ] as const).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => setPhase(key)}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold tracking-wider uppercase transition-colors",
                phase === key ? "text-[var(--cryp-ink)]" : "text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]",
              )}
              style={{
                background: phase === key ? "var(--cryp-teal)" : "transparent",
                border: `1px solid ${phase === key ? "var(--cryp-teal)" : "var(--cryp-line)"}`,
              }}
            >
              <Icon className="w-3 h-3" />
              {label}
              <span className="opacity-70 font-mono-num">{phaseCounts[key]}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="flex flex-wrap gap-1">
            {(["1h", "6h", "24h", "7d", "all"] as const).map(key => (
              <button
                key={key}
                type="button"
                onClick={() => setAge(key)}
                className={cn(
                  "px-2.5 py-1 text-[10px] font-bold tracking-wider uppercase",
                  age === key ? "text-[var(--cryp-mint)]" : "text-[var(--cryp-mute)]",
                )}
                style={{ border: `1px solid ${age === key ? "var(--cryp-teal)" : "var(--cryp-line)"}` }}
              >
                {key.toUpperCase()}
              </button>
            ))}
          </div>
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search symbol or CA"
            className="flex-1 bg-transparent text-[12px] px-3 py-1.5 outline-none placeholder:text-[var(--cryp-mute)]"
            style={{ border: "1px solid var(--cryp-line)" }}
          />
        </div>
      </section>

      <section className={cn("space-y-3 fade-up fade-up-delay-3 transition-opacity duration-200", isPlaceholderData && "opacity-80")}>
        <div className="text-[11px] tracking-[0.2em] uppercase text-[var(--cryp-mute)]">
          {showSkeleton ? "Loading…" : `${tokens.length} token${tokens.length === 1 ? "" : "s"}`}
        </div>

        {showSkeleton && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {[0, 1, 2, 3, 4, 5].map(i => <DeskSkeleton key={i} />)}
          </div>
        )}

        {!showSkeleton && tokens.length === 0 && (
          <div className="desk-card p-10 text-center">
            <div className="font-display text-lg font-bold">Nothing in this lane</div>
            <div className="text-sm text-[var(--cryp-mute)] mt-2 max-w-md mx-auto">
              Radar fills from early wallet buys. Heating / Entry appear when MC velocity confirms.
            </div>
          </div>
        )}

        {!showSkeleton && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {tokens.map(t => (
              <TokenCard key={t.id} t={t} onOpen={() => setLocation(`/tokens/${t.id}`)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
