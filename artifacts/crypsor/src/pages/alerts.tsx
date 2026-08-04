/**
 * Pump-desk Alerts — notification center, logs, Telegram/milestone stats.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellRing, CheckCheck, ExternalLink, Radio } from "lucide-react";
import {
  cn, formatCompactUsd, formatTimeAgo, getGmgnUrl, safeSymbol,
} from "@/lib/utils";
import { useLiveSse } from "@/hooks/use-live-tokens";
import {
  ALERTS_FEED_KEY, ALERTS_STATS_KEY, ALERTS_UNREAD_KEY,
  alertAccent, fetchAlerts, fetchAlertsStats, markAlertsRead,
  type PumpAlert,
} from "@/lib/alerts-api";

function StatTile({
  label, value, hint, accent,
}: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <div className="desk-card px-3 py-3 fade-up">
      <div className="text-[9px] tracking-[0.16em] uppercase text-[var(--cryp-mute)]">{label}</div>
      <div
        className="font-display font-mono-num text-xl font-bold mt-1"
        style={{ color: accent ?? "var(--cryp-text)" }}
      >
        {value}
      </div>
      {hint && <div className="text-[10px] text-[var(--cryp-mute)] mt-0.5">{hint}</div>}
    </div>
  );
}

function AlertRow({
  a, onOpen, onRead,
}: {
  a: PumpAlert;
  onOpen: () => void;
  onRead: () => void;
}) {
  const unread = !a.readAt;
  const gmgn = a.address ? getGmgnUrl("solana", a.address) : null;
  const sym = safeSymbol(a.symbol, a.address) || "?";

  return (
    <article
      className={cn(
        "desk-card cursor-pointer transition-colors fade-up",
        unread && "ring-1 ring-[rgba(61,154,139,0.35)]",
      )}
      onClick={() => {
        if (unread) onRead();
        onOpen();
      }}
    >
      <div className="p-3.5 flex gap-3">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: `${alertAccent(a.kind)}22`, color: alertAccent(a.kind) }}
        >
          {unread ? <BellRing className="w-4 h-4" /> : <Bell className="w-4 h-4 opacity-60" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{
                color: alertAccent(a.kind),
                background: `${alertAccent(a.kind)}18`,
                border: `1px solid ${alertAccent(a.kind)}44`,
              }}
            >
              {a.label}
            </span>
            {a.grade && (
              <span className="text-[9px] font-bold text-[var(--cryp-mute)]">
                {a.grade}{a.score != null ? ` ${a.score}` : ""}
              </span>
            )}
            {a.telegramSent && (
              <span className="text-[9px] font-bold uppercase text-[var(--cryp-mint)]">TG</span>
            )}
            {unread && (
              <span className="text-[9px] font-bold uppercase text-[var(--cryp-gain)]">New</span>
            )}
          </div>
          <div className="font-display font-bold text-[13px] mt-1 truncate">
            ${sym} · {a.title.replace(/^\$\S+\s*/, "")}
          </div>
          {a.body && (
            <div className="text-[11px] text-[var(--cryp-mute)] mt-0.5 line-clamp-2">{a.body}</div>
          )}
          <div className="flex items-center gap-2 mt-1.5 text-[10px] text-[var(--cryp-mute)] font-mono-num">
            <span>{formatTimeAgo(a.createdAt)} ago</span>
            {a.mcAtDetection != null && (
              <span>Detect {formatCompactUsd(a.mcAtDetection)}</span>
            )}
            {a.marketCapUsd != null && (
              <span>→ {formatCompactUsd(a.marketCapUsd)}</span>
            )}
            {a.gainPct != null && (
              <span style={{ color: a.gainPct >= 0 ? "var(--cryp-gain)" : "var(--cryp-loss)" }}>
                {a.gainPct >= 0 ? "+" : ""}{a.gainPct.toFixed(0)}%
              </span>
            )}
            {gmgn && (
              <a
                href={gmgn}
                target="_blank"
                rel="noreferrer"
                className="ml-auto text-[var(--cryp-mint)]"
                onClick={(e) => e.stopPropagation()}
                aria-label="Open chart"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

const KIND_FILTERS = [
  { id: "", label: "ALL" },
  { id: "STRONG_BUY", label: "BUY" },
  { id: "INTRA_NOW", label: "INTRA" },
  { id: "GRADE_A", label: "A+" },
  { id: "GAIN_50", label: "GAINED" },
  { id: "ATH_2X", label: "2×" },
  { id: "ATH_5X", label: "5×" },
  { id: "LARRY", label: "LARRY" },
];

export default function AlertsPage() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { connected } = useLiveSse();
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [kind, setKind] = useState("");
  const [notifState, setNotifState] = useState<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );

  const statsQ = useQuery({
    queryKey: ALERTS_STATS_KEY,
    queryFn: fetchAlertsStats,
    refetchInterval: connected ? 45_000 : 15_000,
  });

  const feedQ = useQuery({
    queryKey: ALERTS_FEED_KEY(page, unreadOnly, kind),
    queryFn: () => fetchAlerts({ page, limit: 30, unread: unreadOnly, kind: kind || undefined }),
    refetchInterval: connected ? 60_000 : 12_000,
  });

  const readMut = useMutation({
    mutationFn: markAlertsRead,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pump-alerts"] });
      void qc.invalidateQueries({ queryKey: ALERTS_STATS_KEY });
      void qc.invalidateQueries({ queryKey: ALERTS_UNREAD_KEY });
    },
  });

  const alerts = feedQ.data?.alerts ?? [];
  const stats = statsQ.data;
  const unread = feedQ.data?.unread ?? stats?.unread ?? 0;

  const enableBrowserPush = async () => {
    if (typeof Notification === "undefined") return;
    const perm = await Notification.requestPermission();
    setNotifState(perm);
  };

  const kindHint = useMemo(() => {
    if (!stats?.byKind?.length) return null;
    return stats.byKind.slice(0, 6).map((k) => `${k.kind} ${k.count}`).join(" · ");
  }, [stats]);

  return (
    <div className="px-2 sm:px-3 pt-2.5 pb-8 space-y-3 w-full max-w-3xl mx-auto">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="font-display font-bold text-[15px] tracking-wide flex items-center gap-2">
            <BellRing className="w-4 h-4 text-[var(--cryp-mint)]" />
            Alerts
          </div>
          <div className="text-[11px] text-[var(--cryp-mute)] mt-0.5">
            Pump-desk notables · Telegram + browser · {connected ? "live" : "sync"}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {notifState !== "granted" && notifState !== "unsupported" && (
            <button
              type="button"
              onClick={() => void enableBrowserPush()}
              className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1.5 rounded-lg"
              style={{
                color: "var(--cryp-mint)",
                background: "rgba(61,154,139,0.14)",
                border: "1px solid rgba(61,154,139,0.35)",
              }}
            >
              Enable push
            </button>
          )}
          {notifState === "granted" && (
            <span className="text-[10px] uppercase tracking-wider text-[var(--cryp-gain)] flex items-center gap-1">
              <Radio className="w-3 h-3" /> Browser on
            </span>
          )}
          {unread > 0 && (
            <button
              type="button"
              onClick={() => readMut.mutate({ all: true })}
              className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1.5 rounded-lg text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]"
            >
              <CheckCheck className="w-3.5 h-3.5 inline mr-1" />
              Mark all read
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatTile label="Total" value={String(stats?.total ?? "—")} hint="all time" />
        <StatTile
          label="Unread"
          value={String(unread)}
          accent="var(--cryp-gain)"
          hint="notification center"
        />
        <StatTile
          label="Telegram"
          value={String(stats?.telegramSent ?? "—")}
          accent="var(--cryp-mint)"
          hint="pushed"
        />
        <StatTile
          label="Milestones"
          value={String(stats?.milestones ?? "—")}
          hint={`2× ${stats?.ath2x ?? 0} · 5× ${stats?.ath5x ?? 0} · 10× ${stats?.ath10x ?? 0}`}
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatTile label="READY BUY" value={String(stats?.strongBuy ?? 0)} accent="var(--cryp-gain)" />
        <StatTile label="INTRADAY" value={String(stats?.intraNow ?? 0)} accent="#ff8300" />
        <StatTile label="S / A" value={String(stats?.gradeSa ?? 0)} accent="var(--cryp-teal)" />
        <StatTile label="GAINED 50%+" value={String(stats?.gain50 ?? 0)} accent="var(--cryp-mint)" />
      </div>

      {kindHint && (
        <div className="text-[10px] text-[var(--cryp-mute)] font-mono-num px-1">
          24h {stats?.last24h ?? 0} · {kindHint}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 items-center">
        {KIND_FILTERS.map((f) => (
          <button
            key={f.id || "all"}
            type="button"
            onClick={() => { setKind(f.id); setPage(1); }}
            className={cn(
              "text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-md border transition-colors",
              kind === f.id
                ? "text-[var(--cryp-mint)] border-[rgba(61,154,139,0.5)] bg-[rgba(61,154,139,0.14)]"
                : "text-[var(--cryp-mute)] border-[var(--cryp-line)] hover:text-[var(--cryp-text)]",
            )}
          >
            {f.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => { setUnreadOnly((v) => !v); setPage(1); }}
          className={cn(
            "ml-auto text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-md border",
            unreadOnly
              ? "text-[var(--cryp-gain)] border-[rgba(62,207,142,0.45)]"
              : "text-[var(--cryp-mute)] border-[var(--cryp-line)]",
          )}
        >
          Unread only
        </button>
      </div>

      <div className="space-y-2">
        {feedQ.isLoading && alerts.length === 0 && (
          <div className="desk-card p-6 text-center text-[var(--cryp-mute)] text-sm">Loading alerts…</div>
        )}
        {feedQ.isError && (
          <div className="desk-card p-4 text-[var(--cryp-loss)] text-sm">
            Failed to load alerts
          </div>
        )}
        {!feedQ.isLoading && alerts.length === 0 && (
          <div className="desk-card p-6 text-center text-[var(--cryp-mute)] text-sm">
            No alerts yet — STRONG BUY, INTRA, S/A, EEI, and gain milestones will land here
            and on Telegram.
          </div>
        )}
        {alerts.map((a) => (
          <AlertRow
            key={a.id}
            a={a}
            onOpen={() => setLocation(`/calls/${a.tokenId}`)}
            onRead={() => readMut.mutate({ ids: [a.id] })}
          />
        ))}
      </div>

      {(feedQ.data?.pages ?? 1) > 1 && (
        <div className="flex justify-center gap-2 pt-1">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="text-[11px] px-3 py-1.5 rounded-lg border border-[var(--cryp-line)] text-[var(--cryp-mute)] disabled:opacity-40"
          >
            Prev
          </button>
          <span className="text-[11px] text-[var(--cryp-mute)] self-center font-mono-num">
            {page}/{feedQ.data?.pages ?? 1}
          </span>
          <button
            type="button"
            disabled={page >= (feedQ.data?.pages ?? 1)}
            onClick={() => setPage((p) => p + 1)}
            className="text-[11px] px-3 py-1.5 rounded-lg border border-[var(--cryp-line)] text-[var(--cryp-mute)] disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
