/**
 * Best Calls — mobile-first FOMO-style desk.
 * Surfaces a handful of quality calls from the tracked universe using
 * multi-buy wallets, tagged holders, and buyer win-rate — any market cap.
 */
import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Copy, ExternalLink, Flame, Zap, Trophy, TrendingUp, ChevronDown, ChevronUp,
  Hourglass,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  cn, truncateAddress, formatCompactUsd, formatTimeAgo,
  getGmgnUrl, safeSymbol, safeImageUrl,
} from "@/lib/utils";
import {
  CALLS_FEED_KEY, CALLS_STATS_KEY,
  fetchCallsFeed, fetchCallsStats,
  type CallCard, type CallMode, type StatsPeriod,
} from "@/lib/calls-api";
import { OPS_SUMMARY_KEY, fetchOpsSummary } from "@/lib/ops-api";

const STATS_PERIODS: { id: StatsPeriod; label: string }[] = [
  { id: "1d", label: "1D" },
  { id: "3d", label: "3D" },
  { id: "5d", label: "5D" },
  { id: "7d", label: "7D" },
  { id: "30d", label: "30D" },
];

function fmtAge(min: number | null | undefined): string | null {
  if (min == null || !Number.isFinite(min)) return null;
  if (min < 60) return `${min}m old`;
  if (min < 60 * 24) return `${Math.round(min / 60)}h old`;
  return `${Math.round(min / (60 * 24))}d old`;
}

function StatTile({
  icon, label, value, hint, accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  accent?: string;
}) {
  return (
    <div className="call-stat fade-up">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[var(--cryp-teal)]">{icon}</span>
        <span className="text-[10px] tracking-[0.16em] uppercase text-[var(--cryp-mute)]">{label}</span>
      </div>
      <div
        className="font-display font-mono-num text-[22px] font-bold tracking-tight leading-none"
        style={{ color: accent ?? "var(--cryp-text)" }}
      >
        {value}
      </div>
      {hint && <div className="text-[11px] text-[var(--cryp-mute)] mt-1.5 truncate">{hint}</div>}
    </div>
  );
}

function LiveBar({ now, peak }: { now: number; peak: number }) {
  const max = Math.max(peak, now, 1);
  const nowPct = Math.min(100, (now / max) * 100);
  const peakPct = Math.min(100, (peak / max) * 100);
  return (
    <div className="mt-1">
      <div className="relative h-2 rounded-full overflow-hidden" style={{ background: "rgba(125,180,170,0.12)" }}>
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${peakPct}%`,
            background: "rgba(62,207,142,0.22)",
          }}
        />
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${nowPct}%`,
            background: "linear-gradient(90deg, #2f8f7e, #3ecf8e)",
          }}
        />
      </div>
      <div className="flex items-center justify-between mt-1.5 text-[11px]">
        <span className="font-mono-num text-[var(--cryp-warn)]">Now {now.toFixed(2)}×</span>
        <span className="font-mono-num text-[var(--cryp-gain)]">Peak {peak.toFixed(1)}× ✓</span>
      </div>
    </div>
  );
}

function WaitingCardView({ c }: { c: CallCard }) {
  const [, setLocation] = useLocation();
  const [imgBroken, setImgBroken] = useState(false);
  const imgSrc = safeImageUrl(c.logoUri, c.address, c.symbol);
  const sym = safeSymbol(c.symbol, c.address) || "?";
  const phase = c.runnerPhase ?? "radar";
  const snaps = c.snapCount ?? 0;
  const need = c.snapsNeeded ?? Math.max(0, 5 - snaps);
  const phaseColor =
    phase === "entry" ? "var(--cryp-gain)"
      : phase === "heating" ? "var(--cryp-warn)"
        : "var(--cryp-teal)";

  return (
    <article
      className="call-card fade-up cursor-pointer transition-transform duration-200 active:scale-[0.99] hover:-translate-y-0.5"
      onClick={() => setLocation(`/calls/${c.id}`)}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setLocation(`/calls/${c.id}`);
        }
      }}
    >
      <div className="flex items-start gap-3">
        {!imgBroken ? (
          <img
            src={imgSrc}
            alt=""
            className="w-11 h-11 rounded-full object-cover shrink-0"
            style={{ background: "var(--cryp-elevated)", border: "1px solid var(--cryp-line)" }}
            onError={() => setImgBroken(true)}
          />
        ) : (
          <div
            className="w-11 h-11 rounded-full shrink-0 flex items-center justify-center text-[11px] font-bold"
            style={{ background: "rgba(245,158,11,0.16)", color: "var(--cryp-warn)" }}
          >
            {sym.slice(0, 2)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-display font-bold text-[15px]">${sym}</h3>
            <span
              className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5"
              style={{ color: "var(--cryp-ink)", background: phaseColor }}
            >
              {c.runnerLabel ?? phase} {c.runnerScore ?? ""}
            </span>
            {c.alertEligible && (
              <span className="text-[9px] font-bold uppercase text-[var(--cryp-mint)]">Ready</span>
            )}
          </div>
          <div className="text-[11px] text-[var(--cryp-mute)] mt-0.5 font-mono-num">
            {truncateAddress(c.address)}
            {c.calledAt ? ` · ${formatTimeAgo(c.calledAt)} ago` : ""}
          </div>
        </div>
      </div>

      <div className="mt-3 px-2.5 py-2 rounded-lg text-[12px] leading-snug"
        style={{
          background: "rgba(245,158,11,0.08)",
          border: "1px solid rgba(245,158,11,0.22)",
          color: "var(--cryp-warn)",
        }}
      >
        <span className="font-semibold">Hold · </span>
        {c.holdReason ?? c.blockers?.[0] ?? "Waiting on ENTRY gates"}
      </div>

      <div className="grid grid-cols-4 gap-2 mt-3">
        {[
          { label: "Snaps", value: `${snaps}/5` },
          { label: "Need", value: need > 0 ? String(need) : "ok" },
          { label: "Now", value: `${(c.nowMultiple ?? 1).toFixed(2)}×` },
          { label: "Entry", value: formatCompactUsd(c.calledMcUsd) },
        ].map(m => (
          <div key={m.label}>
            <div className="text-[9px] uppercase tracking-wider text-[var(--cryp-mute)]">{m.label}</div>
            <div className="font-mono-num text-[13px] font-semibold mt-0.5">{m.value}</div>
          </div>
        ))}
      </div>

      {(c.blockers?.length ?? 0) > 0 && (
        <div className="mt-3 pt-3 text-[11px] text-[var(--cryp-mute)]" style={{ borderTop: "1px solid var(--cryp-line)" }}>
          <span className="text-[var(--cryp-warn)] font-semibold">Gates · </span>
          {c.blockers!.join(" · ")}
        </div>
      )}
    </article>
  );
}

function CallCardView({ c }: { c: CallCard }) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [imgBroken, setImgBroken] = useState(false);
  const [open, setOpen] = useState(true);
  const imgSrc = safeImageUrl(c.logoUri, c.address, c.symbol);
  const sym = safeSymbol(c.symbol, c.address) || "?";
  const athX = Number.isFinite(c.athMultiple) ? c.athMultiple : 1;
  const nowX = Number.isFinite(c.nowMultiple) ? c.nowMultiple : 1;
  const athBadge = athX >= 2
    ? `${athX >= 10 ? Math.round(athX) : athX.toFixed(1)}x ATH`
    : null;

  const walletLabel = c.walletBuys > 0
    ? `${c.walletBuys} wallet${c.walletBuys === 1 ? "" : "s"}`
    : c.calledSmart + c.calledKol > 0
      ? `${c.calledSmart + c.calledKol} tagged`
      : null;

  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(c.address);
    toast({ title: "Copied", description: truncateAddress(c.address) });
  };

  const openDetail = () => setLocation(`/calls/${c.id}`);

  return (
    <article
      className="call-card fade-up cursor-pointer transition-transform duration-200 active:scale-[0.99] hover:-translate-y-0.5"
      onClick={openDetail}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openDetail();
        }
      }}
    >
      <div className="flex items-start gap-3">
        {!imgBroken ? (
          <img
            src={imgSrc}
            alt=""
            className="w-11 h-11 rounded-full object-cover shrink-0"
            style={{ background: "var(--cryp-elevated)", border: "1px solid var(--cryp-line)" }}
            onError={() => setImgBroken(true)}
          />
        ) : (
          <div
            className="w-11 h-11 rounded-full shrink-0 flex items-center justify-center text-[11px] font-bold"
            style={{ background: "rgba(61,154,139,0.18)", color: "var(--cryp-mint)" }}
          >
            {sym.slice(0, 2)}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h3 className="font-display text-[16px] font-bold truncate">${sym}</h3>
                <button type="button" onClick={copy} className="text-[var(--cryp-mute)] hover:text-[var(--cryp-mint)]">
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="text-[12px] text-[var(--cryp-mute)] truncate mt-0.5">
                {c.name || truncateAddress(c.address)}
              </div>
            </div>

            <div className="flex flex-col items-end gap-1.5 shrink-0">
              {walletLabel && (
                <span className="wallet-pill">
                  <Flame className="w-3 h-3" />
                  {walletLabel}
                  {c.buyVolumeHintUsd != null && c.buyVolumeHintUsd > 0
                    ? ` · ${formatCompactUsd(c.buyVolumeHintUsd)}`
                    : ""}
                </span>
              )}
              <div className="flex items-center gap-1 flex-wrap justify-end">
                {c.ctoFlag === true && (
                  <span
                    className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md"
                    style={{ color: "#04120c", background: "#7dd3c0" }}
                    title="Community takeover — original creator exited"
                  >
                    CTO
                  </span>
                )}
                {c.creatorClose === false && (
                  <span
                    className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md"
                    style={{ color: "#fff", background: "rgba(232,93,93,0.75)" }}
                    title="Creator still holding"
                  >
                    Dev hold
                  </span>
                )}
                <span
                  className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md"
                  style={{
                    color: c.callLabel === "elite" ? "var(--cryp-ink)" : "var(--cryp-mint)",
                    background: c.callLabel === "elite"
                      ? "var(--cryp-mint)"
                      : c.callLabel === "strong"
                        ? "rgba(61,154,139,0.2)"
                        : "rgba(122,143,153,0.16)",
                  }}
                >
                  {c.callLabel} {c.callScore}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 mt-2.5 flex-wrap">
            <span className="text-[12px] text-[var(--cryp-mute)]">
              Called {c.calledAt ? formatTimeAgo(c.calledAt) : "—"} ago
            </span>
            {athBadge && (
              <span className="ath-pill">{athBadge}</span>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mt-4">
        {[
          { l: "Call MC", v: formatCompactUsd(c.calledMcUsd), accent: "var(--cryp-text)" },
          { l: "Current", v: formatCompactUsd(c.currentMcUsd), accent: "var(--cryp-text)" },
          { l: "ATH", v: formatCompactUsd(c.athMcUsd), accent: "var(--cryp-gain)" },
        ].map(x => (
          <div key={x.l}>
            <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">{x.l}</div>
            <div className="font-mono-num text-[15px] font-bold mt-0.5" style={{ color: x.accent }}>{x.v}</div>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="w-full flex items-center justify-between mt-4 pt-3 text-[10px] font-bold uppercase tracking-widest text-[var(--cryp-mute)]"
        style={{ borderTop: "1px solid var(--cryp-line)" }}
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
      >
        Live metrics
        {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>

      {open && (
        <div className="pb-1">
          <LiveBar now={nowX} peak={Math.max(athX, nowX)} />
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[11px] text-[var(--cryp-mute)]">
            {c.avgWalletWinRate != null && (
              <span>Buyer WR {(c.avgWalletWinRate * 100).toFixed(0)}%</span>
            )}
            {(c.calledSmart > 0 || c.calledKol > 0) && (
              <span>Smart {c.calledSmart} · KOL {c.calledKol}</span>
            )}
            {c.creatorCreatedCount != null && (
              <span>Creator {c.creatorCreatedCount} tokens</span>
            )}
            {c.creatorClose === true && <span>Creator closed</span>}
            {fmtAge(c.tokenAgeMin) && <span>{fmtAge(c.tokenAgeMin)}</span>}
            {c.volume24hUsd != null && c.volume24hUsd > 0 && (
              <span>{formatCompactUsd(c.volume24hUsd)} vol</span>
            )}
          </div>
          {c.reasons.length > 0 && (
            <div className="mt-2 text-[11px] text-[var(--cryp-mute)] leading-snug">
              {c.reasons.slice(0, 2).join(" · ")}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 mt-3">
        <a
          href={getGmgnUrl(c.chain, c.address)}
          target="_blank"
          rel="noreferrer"
          className="call-action"
          onClick={e => e.stopPropagation()}
        >
          <ExternalLink className="w-3.5 h-3.5" />
          Buy
        </a>
        <button
          type="button"
          className="call-action"
          onClick={(e) => {
            e.stopPropagation();
            const text = `$${sym} · ${athX.toFixed(1)}× ATH · Call ${formatCompactUsd(c.calledMcUsd)} → Now ${formatCompactUsd(c.currentMcUsd)}\n${c.address}`;
            void navigator.clipboard.writeText(text);
            toast({ title: "Copied call", description: `$${sym}` });
          }}
        >
          Share
        </button>
      </div>
    </article>
  );
}

export default function CallsPage() {
  const [mode, setMode] = useState<CallMode>(() => {
    if (typeof window === "undefined") return "best";
    const q = new URLSearchParams(window.location.search).get("mode");
    return q === "waiting" || q === "hot" || q === "latest" || q === "best" ? q : "best";
  });
  const [period, setPeriod] = useState<StatsPeriod>("7d");

  const { data: stats } = useQuery({
    queryKey: CALLS_STATS_KEY(period),
    queryFn: () => fetchCallsStats(period),
    refetchInterval: 20_000,
    placeholderData: keepPreviousData,
  });

  const { data: opsSummary } = useQuery({
    queryKey: OPS_SUMMARY_KEY,
    queryFn: fetchOpsSummary,
    refetchInterval: 20_000,
    staleTime: 10_000,
  });

  const {
    data, isLoading, isFetching, isError, error, refetch,
  } = useQuery({
    queryKey: CALLS_FEED_KEY(mode),
    queryFn: () => fetchCallsFeed(mode, mode === "best" ? 8 : mode === "waiting" ? 24 : 40),
    refetchInterval: 12_000,
    staleTime: 6_000,
    placeholderData: keepPreviousData,
    retry: 4,
  });

  const cards = data?.cards ?? [];
  const universe = data?.universe ?? stats?.universe ?? 0;
  const pendingN = data?.pendingFirstCalls
    ?? opsSummary?.telegram?.pendingFirstCalls
    ?? 0;

  const modes = useMemo(() => ([
    { id: "best" as const, label: "Best", icon: Trophy },
    { id: "waiting" as const, label: "Waiting", icon: Hourglass },
    { id: "hot" as const, label: "Hot", icon: Flame },
    { id: "latest" as const, label: "Latest", icon: Zap },
  ]), []);

  return (
    <div className="px-4 pt-4 pb-10 space-y-4">
      <header className="fade-up">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="font-display text-[22px] font-extrabold tracking-tight">
              Best calls
            </h1>
            <p className="text-[12px] text-[var(--cryp-mute)] mt-1 leading-relaxed">
              ~{universe || "—"} tracked · win-rate = ENTRY-served only
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isFetching && (
              <span className="text-[10px] uppercase tracking-widest text-[var(--cryp-mute)]">sync</span>
            )}
            <label className="relative inline-flex items-center">
              <span className="sr-only">Stats period</span>
              <select
                value={period}
                onChange={(e) => setPeriod(e.target.value as StatsPeriod)}
                className="appearance-none pl-2.5 pr-7 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-wider"
                style={{
                  color: "var(--cryp-mint)",
                  background: "rgba(16,27,36,0.95)",
                  border: "1px solid var(--cryp-line)",
                }}
                aria-label="Win rate period"
              >
                {STATS_PERIODS.map(p => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
              <ChevronDown
                className="w-3 h-3 absolute right-2 pointer-events-none"
                style={{ color: "var(--cryp-mute)" }}
              />
            </label>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-2.5">
        <StatTile
          icon={<TrendingUp className="w-4 h-4" />}
          label={`Win rate · ${period.toUpperCase()}`}
          value={`${stats?.winRate ?? "—"}%`}
          hint={stats
            ? `${stats.wins}/${stats.signals} ENTRY hit 2×${stats.deskRaw != null ? ` · desk ${stats.deskRaw}` : ""}`
            : "loading"}
          accent="var(--cryp-mint)"
        />
        <StatTile
          icon={<Trophy className="w-4 h-4" />}
          label="Highest X"
          value={stats?.bestX ? `${stats.bestX.toFixed(1)}x` : "—"}
          hint={stats?.bestSymbol ? `$${stats.bestSymbol}` : "—"}
          accent="var(--cryp-warn)"
        />
        <StatTile
          icon={<Zap className="w-4 h-4" />}
          label="ENTRY served"
          value={stats ? String(stats.signals) : "—"}
          hint={stats?.telegramN != null
            ? `${stats.telegramN} Telegram · ${period.toUpperCase()}`
            : `${period.toUpperCase()} ENTRY`}
        />
        <StatTile
          icon={<Flame className="w-4 h-4" />}
          label="Avg X"
          value={stats?.avgX ? `${stats.avgX.toFixed(2)}x` : "—"}
          hint={`${period.toUpperCase()} ENTRY avg`}
          accent="var(--cryp-teal)"
        />
      </div>

      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-0.5">
        {modes.map(m => {
          const Icon = m.icon;
          const active = mode === m.id;
          const count = m.id === "waiting" ? pendingN : null;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                setMode(m.id);
                const url = new URL(window.location.href);
                if (m.id === "best") url.searchParams.delete("mode");
                else url.searchParams.set("mode", m.id);
                window.history.replaceState({}, "", url.pathname + url.search);
              }}
              className={cn(
                "flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[12px] font-bold transition-colors shrink-0",
                active
                  ? m.id === "waiting"
                    ? "bg-[var(--cryp-warn)] text-[var(--cryp-ink)]"
                    : "bg-[var(--cryp-teal)] text-[var(--cryp-ink)]"
                  : "text-[var(--cryp-mute)] bg-[rgba(16,27,36,0.9)] border border-[var(--cryp-line)]",
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {m.label}
              {count != null && count > 0 && (
                <span className="font-mono-num opacity-80">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {mode === "best" && (
        <p className="text-[11px] text-[var(--cryp-mute)] leading-relaxed fade-up">
          ENTRY-served + proper very_good only — not the raw good desk flood. Aim: a few clear calls.
        </p>
      )}
      {mode === "waiting" && (
        <p className="text-[11px] text-[var(--cryp-mute)] leading-relaxed fade-up">
          Ops “pending first calls” — very_good coins held for snaps / freshness / smart-hold before Telegram ENTRY.
        </p>
      )}

      <div className="space-y-3">
        {isError && cards.length === 0 && (
          <div className="call-card text-center py-8 space-y-3">
            <div className="text-[13px] text-[var(--cryp-loss)]">
              Couldn’t load calls
            </div>
            <div className="text-[11px] text-[var(--cryp-mute)] px-4">
              {error instanceof Error ? error.message : "API waking up or timed out"}
              {" — "}tap retry (Render free tier may take ~30s on first wake)
            </div>
            <button
              type="button"
              onClick={() => void refetch()}
              className="call-action mx-auto"
            >
              Retry
            </button>
          </div>
        )}
        {isLoading && cards.length === 0 && !isError && (
          <>
            {[0, 1, 2].map(i => (
              <div key={i} className="call-card shimmer-card h-44" />
            ))}
          </>
        )}
        {!isLoading && !isError && cards.length === 0 && (
          <div className="call-card text-center py-12 text-[12px] text-[var(--cryp-mute)] uppercase tracking-widest">
            {mode === "waiting"
              ? "Nothing waiting — queue clear"
              : "No quality calls yet — scanning wallets"}
          </div>
        )}
        {cards.map(c => (
          mode === "waiting"
            ? <WaitingCardView key={c.id} c={c} />
            : <CallCardView key={c.id} c={c} />
        ))}
      </div>
    </div>
  );
}
