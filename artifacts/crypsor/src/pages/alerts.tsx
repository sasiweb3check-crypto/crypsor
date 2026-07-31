/**
 * Runner ENTRY tracker — Telegram pings + live Entry / Heating lanes.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Bell, ExternalLink, Radio, Rocket } from "lucide-react";
import {
  cn, truncateAddress, formatCompactUsd, formatTimeAgo,
  getGmgnUrl, safeSymbol, safeImageUrl,
} from "@/lib/utils";
import {
  fetchRunnerAlerts, RUNNER_ALERTS_KEY, type RunnerToken,
} from "@/lib/runner-api";

type AlertTab = "sent" | "entry" | "heating";

function StatTile({
  label, value, hint, accent,
}: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <div className="desk-card px-4 py-3.5 fade-up">
      <div className="text-[10px] tracking-[0.18em] uppercase text-[var(--cryp-mute)]">{label}</div>
      <div className="font-display font-mono-num text-2xl font-bold mt-1.5" style={{ color: accent ?? "var(--cryp-text)" }}>
        {value}
      </div>
      {hint && <div className="text-[11px] text-[var(--cryp-mute)] mt-1">{hint}</div>}
    </div>
  );
}

function CardSkeleton() {
  return (
    <div className="desk-card p-4 shimmer-card">
      <div className="flex gap-3">
        <div className="shimmer w-11 h-11" />
        <div className="flex-1 space-y-2">
          <div className="shimmer h-4 w-24" />
          <div className="shimmer h-3 w-40" />
          <div className="grid grid-cols-4 gap-2"><div className="shimmer h-8" /><div className="shimmer h-8" /><div className="shimmer h-8" /><div className="shimmer h-8" /></div>
        </div>
      </div>
    </div>
  );
}

function AlertCard({ t, onOpen }: { t: RunnerToken; onOpen: () => void }) {
  const [imgBroken, setImgBroken] = useState(false);
  const gain = t.gainPct ?? 0;
  const ath = t.athMultiple ?? 1;

  return (
    <article className="desk-card cursor-pointer hover:-translate-y-0.5 transition-transform fade-up" onClick={onOpen}>
      <div className="p-4 md:p-5">
        <div className="flex items-start gap-3">
          {!imgBroken ? (
            <img src={safeImageUrl(t.logoUri, t.address, t.symbol)} alt="" className="w-11 h-11 object-cover" onError={() => setImgBroken(true)} />
          ) : (
            <div className="w-11 h-11 flex items-center justify-center text-[11px] font-bold" style={{ background: "var(--cryp-elevated)", color: "var(--cryp-mute)" }}>
              {(safeSymbol(t.symbol, t.address) || "?").slice(0, 2)}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-display font-bold text-[15px]">{safeSymbol(t.symbol, t.address)}</h3>
              <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5"
                style={{ color: "var(--cryp-ink)", background: t.runner.phase === "entry" ? "var(--cryp-gain)" : "var(--cryp-teal)" }}>
                {t.runner.label} {t.runner.score}
              </span>
              {t.runnerAlertSentAt && (
                <span className="text-[9px] font-bold uppercase text-[var(--cryp-mint)]">Sent</span>
              )}
              {t.hit10x && <span className="text-[9px] font-bold text-[var(--cryp-mint)]">10×</span>}
              {t.hit5x && !t.hit10x && <span className="text-[9px] font-bold text-[var(--cryp-gain)]">5×</span>}
              {t.hit2x && !t.hit5x && <span className="text-[9px] font-bold text-[var(--cryp-gain)]">2×</span>}
            </div>
            <div className="text-[11px] text-[var(--cryp-mute)] mt-0.5 font-mono-num">
              {truncateAddress(t.address)}
              {t.runnerAlertSentAt ? ` · pinged ${formatTimeAgo(t.runnerAlertSentAt)} ago` : t.calledAt ? ` · ${formatTimeAgo(t.calledAt)} ago` : ""}
            </div>
          </div>
          <a href={getGmgnUrl(t.chain || "solana", t.address)} target="_blank" rel="noreferrer" className="p-1.5 text-[var(--cryp-mute)]" onClick={e => e.stopPropagation()}>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>

        <div className="grid grid-cols-4 gap-2 mt-3.5">
          {[
            { label: "Vel", value: `${(t.velocity ?? 1).toFixed(2)}×` },
            { label: "Gain", value: `${gain >= 0 ? "+" : ""}${Math.round(gain)}%`, color: gain >= 0 ? "var(--cryp-gain)" : "var(--cryp-loss)" },
            { label: "ATH", value: `${ath.toFixed(1)}×` },
            { label: "Entry", value: formatCompactUsd(t.calledMcUsd) },
          ].map(m => (
            <div key={m.label}>
              <div className="text-[9px] uppercase tracking-wider text-[var(--cryp-mute)]">{m.label}</div>
              <div className="font-mono-num text-[13px] font-semibold mt-0.5" style={{ color: m.color ?? "var(--cryp-text)" }}>{m.value}</div>
            </div>
          ))}
        </div>

        {(t.runner.reasons?.length > 0 || t.runner.blockers?.length > 0) && (
          <div className="mt-3 pt-3 text-[11px] text-[var(--cryp-mute)]" style={{ borderTop: "1px solid var(--cryp-line)" }}>
            {t.runner.reasons?.length > 0 && (
              <div><span className="text-[var(--cryp-teal)] font-semibold">Why · </span>{t.runner.reasons.slice(0, 4).join(" · ")}</div>
            )}
            {t.runner.blockers?.length > 0 && (
              <div className="mt-1"><span className="text-[var(--cryp-warn)] font-semibold">Hold · </span>{t.runner.blockers.join(" · ")}</div>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export default function AlertsPage() {
  const [, setLocation] = useLocation();
  const [tab, setTab] = useState<AlertTab>("sent");

  const { data, isLoading, isFetching, isPlaceholderData } = useQuery({
    queryKey: RUNNER_ALERTS_KEY,
    queryFn: fetchRunnerAlerts,
    refetchInterval: 12_000,
    staleTime: 6_000,
    placeholderData: keepPreviousData,
  });

  const stats = data?.stats;
  const list = useMemo(() => {
    if (!data) return [];
    if (tab === "sent") return data.sent;
    if (tab === "entry") return data.entry;
    return data.heating;
  }, [data, tab]);

  const showSkeleton = isLoading && !data;

  return (
    <div className="px-4 md:px-8 pt-5 md:pt-8 space-y-6">
      <header className="fade-up">
        <div className="flex items-center gap-2">
          <Bell className="w-3.5 h-3.5 text-[var(--cryp-teal)]" />
          <div className="font-display text-[11px] tracking-[0.28em] uppercase text-[var(--cryp-teal)]">
            Entry alerts
          </div>
          {isFetching && (
            <span className="inline-flex items-center gap-1 text-[10px] text-[var(--cryp-mute)]">
              <Radio className="w-3 h-3 pulse-dot" /> syncing
            </span>
          )}
        </div>
        <h1 className="font-display text-3xl md:text-4xl font-extrabold tracking-tight mt-1.5">
          Runner pings
        </h1>
        <p className="text-[var(--cryp-mute)] text-sm mt-2 max-w-xl leading-relaxed">
          Telegram fires on <span className="text-[var(--cryp-text)]">ENTRY</span> — velocity confirmed, MC-agnostic.
          Heating is the near-miss lane so nothing good goes silent.
        </p>
      </header>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 fade-up fade-up-delay-1">
        {showSkeleton ? [0, 1, 2, 3].map(i => (
          <div key={i} className="desk-card px-4 py-3.5 space-y-2">
            <div className="shimmer h-3 w-16" /><div className="shimmer h-7 w-12" />
          </div>
        )) : (
          <>
            <StatTile label="Sent" value={String(stats?.sent ?? 0)} hint="Telegram ENTRY" accent="var(--cryp-mint)" />
            <StatTile label="≥2×" value={stats ? `${stats.winRate2x}%` : "—"} hint={`${stats?.x2Count ?? 0} printed`} accent="var(--cryp-gain)" />
            <StatTile label="≥10×" value={stats ? `${stats.winRate10x}%` : "—"} hint={`${stats?.x10Count ?? 0} runners`} accent="var(--cryp-gain)" />
            <StatTile label="Live" value={`${stats?.liveEntry ?? 0}`} hint={`${stats?.liveHeating ?? 0} heating`} />
          </>
        )}
      </section>

      <section className="flex flex-wrap gap-2 fade-up fade-up-delay-2">
        {([
          ["sent", "Sent", stats?.sent ?? 0],
          ["entry", "Entry", stats?.liveEntry ?? 0],
          ["heating", "Heating", stats?.liveHeating ?? 0],
        ] as const).map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              "px-3 py-1.5 text-[11px] font-bold tracking-wider uppercase",
              tab === key ? "text-[var(--cryp-ink)]" : "text-[var(--cryp-mute)]",
            )}
            style={{
              background: tab === key ? "var(--cryp-teal)" : "transparent",
              border: `1px solid ${tab === key ? "var(--cryp-teal)" : "var(--cryp-line)"}`,
            }}
          >
            {label} <span className="font-mono-num opacity-70">{count}</span>
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1.5 text-[11px] text-[var(--cryp-mute)]">
          <Rocket className="w-3 h-3" />
          Momentum entry · soft tagged · no MC gate
        </div>
      </section>

      <section className={cn("space-y-3 fade-up fade-up-delay-3", isPlaceholderData && "opacity-80")}>
        {showSkeleton && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {[0, 1, 2, 3].map(i => <CardSkeleton key={i} />)}
          </div>
        )}
        {!showSkeleton && list.length === 0 && (
          <div className="desk-card p-10 text-center">
            <div className="font-display text-lg font-bold">
              {tab === "sent" ? "No ENTRY pings yet" : tab === "entry" ? "No live entries" : "Nothing heating"}
            </div>
            <div className="text-sm text-[var(--cryp-mute)] mt-2">
              When velocity confirms a runner, it lands here and on Telegram.
            </div>
          </div>
        )}
        {!showSkeleton && list.length > 0 && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {list.map(t => (
              <AlertCard key={`${tab}-${t.id}`} t={t} onOpen={() => setLocation(`/tokens/${t.id}`)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
