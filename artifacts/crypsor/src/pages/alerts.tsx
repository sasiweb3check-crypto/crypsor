/**
 * High-confidence alert tracker — Telegram-sent history + live Alert/Watch lanes.
 * Smooth load: skeletons, placeholderData, prefetch-friendly query key.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Bell, ExternalLink, Radio, Shield } from "lucide-react";
import { getApiBase } from "@/lib/api-base";
import {
  cn, truncateAddress, formatCompactUsd, formatTimeAgo,
  getGmgnUrl, safeSymbol, safeImageUrl,
} from "@/lib/utils";

type AlertTab = "sent" | "alert" | "watch";

interface ConfidenceInfo {
  score: number;
  tier: "alert" | "watch" | "desk";
  label: string;
  alertEligible: boolean;
  reasons: string[];
  blockers?: string[];
}

interface AlertToken {
  id: number;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  logoUri: string | null;
  calledAt: string | null;
  callAlertSentAt: string | null;
  calledMcUsd: number | null;
  calledIntel: number | null;
  calledKol: number;
  calledSmart: number;
  currentMcUsd: number | null;
  gainSinceCall: number | null;
  athMultiple: number;
  runStatus: string;
  proScore: number;
  hit2x: boolean;
  hit5x: boolean;
  hit10x: boolean;
  secMintRenounced: boolean | null;
  outcome?: { code: string; label: string; detail: string } | null;
  confidence: ConfidenceInfo;
}

interface AlertsPayload {
  stats: {
    sent: number;
    winRate2x: number;
    winRate5x: number;
    x2Count: number;
    x5Count: number;
    x10Count: number;
    bestAth: number | null;
    alertLive: number;
    watchLive: number;
    pendingSend: number;
  };
  sent: AlertToken[];
  alert: AlertToken[];
  watch: AlertToken[];
}

export const ALERTS_QUERY_KEY = ["pro-alerts"] as const;

export async function fetchProAlerts(): Promise<AlertsPayload> {
  const r = await fetch(`${getApiBase()}api/pro/alerts`);
  if (!r.ok) throw new Error("Failed to load alerts");
  return r.json();
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

function AlertSkeleton() {
  return (
    <div className="desk-card p-4 md:p-5 shimmer-card">
      <div className="flex items-start gap-3">
        <div className="shimmer w-11 h-11 shrink-0" />
        <div className="flex-1 space-y-2.5 min-w-0">
          <div className="flex gap-2">
            <div className="shimmer h-4 w-20" />
            <div className="shimmer h-4 w-12" />
          </div>
          <div className="shimmer h-3 w-40 max-w-full" />
          <div className="grid grid-cols-4 gap-2 pt-1">
            <div className="shimmer h-8" />
            <div className="shimmer h-8" />
            <div className="shimmer h-8" />
            <div className="shimmer h-8" />
          </div>
        </div>
      </div>
    </div>
  );
}

function AlertCard({ t, onOpen }: { t: AlertToken; onOpen: () => void }) {
  const [imgBroken, setImgBroken] = useState(false);
  const imgSrc = safeImageUrl(t.logoUri, t.address, t.symbol);
  const gain = t.gainSinceCall ?? 0;
  const ath = t.athMultiple ?? 1;
  const sent = Boolean(t.callAlertSentAt);
  const tier = t.confidence?.tier ?? "desk";

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
              style={{ background: "var(--cryp-elevated)", color: "var(--cryp-mute)" }}
            >
              {(safeSymbol(t.symbol, t.address) || "?").slice(0, 2)}
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-display font-bold text-[15px] truncate">
                {safeSymbol(t.symbol, t.address)}
              </h3>
              {sent && (
                <span
                  className="text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5"
                  style={{ color: "var(--cryp-ink)", background: "var(--cryp-teal)" }}
                >
                  Sent
                </span>
              )}
              {!sent && tier === "alert" && (
                <span
                  className="text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5"
                  style={{ color: "var(--cryp-ink)", background: "var(--cryp-gain)" }}
                >
                  Alert {t.confidence.score}
                </span>
              )}
              {tier === "watch" && (
                <span
                  className="text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5"
                  style={{ color: "var(--cryp-warn)", background: "rgba(212,160,23,0.14)" }}
                >
                  Watch {t.confidence.score}
                </span>
              )}
              {t.hit2x && (
                <span className="text-[9px] font-bold text-[var(--cryp-gain)]">2×</span>
              )}
              {t.hit5x && (
                <span className="text-[9px] font-bold text-[var(--cryp-gain)]">5×</span>
              )}
              {t.hit10x && (
                <span className="text-[9px] font-bold text-[var(--cryp-mint)]">10×</span>
              )}
            </div>

            <div className="flex items-center gap-2 mt-0.5 text-[11px] text-[var(--cryp-mute)]">
              <span className="font-mono-num">{truncateAddress(t.address)}</span>
              {t.callAlertSentAt && (
                <span>· alerted {formatTimeAgo(t.callAlertSentAt)} ago</span>
              )}
              {!t.callAlertSentAt && t.calledAt && (
                <span>· called {formatTimeAgo(t.calledAt)} ago</span>
              )}
            </div>
          </div>

          <a
            href={getGmgnUrl(t.chain || "solana", t.address)}
            target="_blank"
            rel="noreferrer"
            className="p-1.5 text-[var(--cryp-mute)] hover:text-[var(--cryp-mint)]"
            onClick={e => e.stopPropagation()}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>

        <div className="grid grid-cols-4 gap-2 mt-3.5">
          {[
            { label: "Entry", value: formatCompactUsd(t.calledMcUsd) },
            {
              label: "Gain",
              value: `${gain >= 0 ? "+" : ""}${Math.round(gain)}%`,
              color: gain >= 0 ? "var(--cryp-gain)" : "var(--cryp-loss)",
            },
            { label: "ATH", value: `${ath.toFixed(1)}×`, color: ath >= 2 ? "var(--cryp-gain)" : undefined },
            {
              label: "Cluster",
              value: `${t.calledSmart}S · ${t.calledKol}K`,
            },
          ].map(m => (
            <div key={m.label} className="min-w-0">
              <div className="text-[9px] tracking-wider uppercase text-[var(--cryp-mute)]">{m.label}</div>
              <div
                className="font-mono-num text-[13px] font-semibold mt-0.5 truncate"
                style={{ color: m.color ?? "var(--cryp-text)" }}
              >
                {m.value}
              </div>
            </div>
          ))}
        </div>

        {(t.confidence.reasons?.length > 0 || t.outcome) && (
          <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--cryp-line)" }}>
            {t.confidence.reasons?.length > 0 && (
              <div className="text-[11px] text-[var(--cryp-mute)] leading-relaxed">
                <span className="text-[var(--cryp-teal)] font-semibold">Why · </span>
                {t.confidence.reasons.slice(0, 4).join(" · ")}
              </div>
            )}
            {t.outcome && (
              <div className="text-[11px] mt-1" style={{ color: "var(--cryp-mute)" }}>
                Outcome · {t.outcome.label}
                {t.outcome.detail ? ` — ${t.outcome.detail}` : ""}
              </div>
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
    queryKey: ALERTS_QUERY_KEY,
    queryFn: fetchProAlerts,
    refetchInterval: 12_000,
    staleTime: 8_000,
    placeholderData: keepPreviousData,
  });

  const stats = data?.stats;
  const list = useMemo(() => {
    if (!data) return [];
    if (tab === "sent") return data.sent;
    if (tab === "alert") return data.alert;
    return data.watch;
  }, [data, tab]);

  const tabs: { key: AlertTab; label: string; count: number }[] = [
    { key: "sent", label: "Sent", count: stats?.sent ?? 0 },
    { key: "alert", label: "Alert", count: stats?.alertLive ?? 0 },
    { key: "watch", label: "Watch", count: stats?.watchLive ?? 0 },
  ];

  const showSkeleton = isLoading && !data;

  return (
    <div className="px-4 md:px-8 pt-5 md:pt-8 space-y-6">
      <header className="fade-up">
        <div className="flex items-center gap-2">
          <Bell className="w-3.5 h-3.5 text-[var(--cryp-teal)]" />
          <div className="font-display text-[11px] tracking-[0.28em] uppercase text-[var(--cryp-teal)]">
            Crypsor Alerts
          </div>
          {isFetching && (
            <span className="inline-flex items-center gap-1 text-[10px] text-[var(--cryp-mute)]">
              <Radio className="w-3 h-3 pulse-dot" />
              syncing
            </span>
          )}
        </div>
        <h1 className="font-display text-3xl md:text-4xl font-extrabold tracking-tight mt-1.5">
          Alert tracker
        </h1>
        <p className="text-[var(--cryp-mute)] text-sm mt-2 max-w-xl leading-relaxed">
          Track Telegram high-confidence sends in-app — entry MC, gain, ATH, and why they fired.
          Live Alert / Watch lanes show what the desk would notify next.
        </p>
      </header>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 fade-up fade-up-delay-1">
        {showSkeleton ? (
          <>
            {[0, 1, 2, 3].map(i => (
              <div key={i} className="desk-card px-4 py-3.5 space-y-2">
                <div className="shimmer h-3 w-16" />
                <div className="shimmer h-7 w-14" />
                <div className="shimmer h-3 w-24" />
              </div>
            ))}
          </>
        ) : (
          <>
            <StatTile
              label="Sent alerts"
              value={String(stats?.sent ?? 0)}
              hint={stats?.pendingSend ? `${stats.pendingSend} pending send` : "Telegram delivered"}
              accent="var(--cryp-mint)"
            />
            <StatTile
              label="Alert ≥2×"
              value={stats ? `${stats.winRate2x}%` : "—"}
              hint={stats ? `${stats.x2Count}/${stats.sent} sent` : undefined}
              accent="var(--cryp-gain)"
            />
            <StatTile
              label="Alert ≥5×"
              value={stats ? `${stats.winRate5x}%` : "—"}
              hint={stats ? `${stats.x5Count} · ${stats.x10Count} at 10×` : undefined}
              accent="var(--cryp-gain)"
            />
            <StatTile
              label="Best sent"
              value={stats?.bestAth != null ? `${Number(stats.bestAth).toFixed(1)}×` : "—"}
              hint={`${stats?.alertLive ?? 0} live alert · ${stats?.watchLive ?? 0} watch`}
            />
          </>
        )}
      </section>

      <section className="flex flex-wrap items-center gap-2 fade-up fade-up-delay-2">
        {tabs.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "px-3 py-1.5 text-[11px] font-bold tracking-wider uppercase transition-colors",
              tab === t.key ? "text-[var(--cryp-ink)]" : "text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]",
            )}
            style={{
              background: tab === t.key ? "var(--cryp-teal)" : "transparent",
              border: `1px solid ${tab === t.key ? "var(--cryp-teal)" : "var(--cryp-line)"}`,
            }}
          >
            {t.label}
            <span className="ml-1 opacity-70 font-mono-num">{t.count}</span>
          </button>
        ))}
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--cryp-mute)] ml-auto">
          <Shield className="w-3 h-3" />
          Cluster · intel≥90 · $5–15K · mint · fresh
        </div>
      </section>

      <section
        className={cn(
          "space-y-3 fade-up fade-up-delay-3 transition-opacity duration-200",
          isPlaceholderData && "opacity-80",
        )}
      >
        <div className="text-[11px] tracking-[0.2em] uppercase text-[var(--cryp-mute)]">
          {showSkeleton ? "Loading…" : `${list.length} ${tab === "sent" ? "sent" : tab}`}
        </div>

        {showSkeleton && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {[0, 1, 2, 3, 4, 5].map(i => <AlertSkeleton key={i} />)}
          </div>
        )}

        {!showSkeleton && list.length === 0 && (
          <div className="desk-card p-10 text-center">
            <div className="font-display text-lg font-bold">
              {tab === "sent" ? "No alerts sent yet" : tab === "alert" ? "No live alerts" : "No watchlist entries"}
            </div>
            <div className="text-sm text-[var(--cryp-mute)] mt-2 max-w-md mx-auto">
              {tab === "sent"
                ? "When Telegram delivers a high-confidence first-call, it appears here with live P&L vs entry."
                : "When a desk call hits hard gates (cluster + intel + sweet-spot MC), it lands in Alert."}
            </div>
          </div>
        )}

        {!showSkeleton && list.length > 0 && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {list.map(t => (
              <AlertCard
                key={`${tab}-${t.id}-${t.callAlertSentAt ?? t.calledAt}`}
                t={t}
                onOpen={() => setLocation(`/tokens/${t.id}`)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
