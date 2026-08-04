/**
 * Pump-desk Alerts — lean notification center (cards + pagination + SSE).
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellRing, CheckCheck, ChevronLeft, ChevronRight, ExternalLink, Radio } from "lucide-react";
import {
  cn, formatCompactUsd, formatTimeAgo, getGmgnUrl, safeSymbol,
} from "@/lib/utils";
import { useLiveSse } from "@/hooks/use-live-tokens";
import {
  ALERTS_FEED_KEY, ALERTS_STATS_KEY, ALERTS_UNREAD_KEY,
  alertAccent, fetchAlerts, fetchAlertsStats, markAlertsRead,
  type PumpAlert,
} from "@/lib/alerts-api";

const PAGE_SIZE = 12;

const KIND_FILTERS = [
  { id: "", label: "All" },
  { id: "STRONG_BUY", label: "Buy" },
  { id: "INTRA_NOW", label: "Intra" },
  { id: "GRADE_A", label: "A+" },
  { id: "GAIN_50", label: "Gained" },
  { id: "ATH_2X", label: "2×" },
  { id: "ATH_5X", label: "5×" },
  { id: "LARRY", label: "Larry" },
];

function AlertCard({
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
      className={cn("desk-card alert-card", unread && "alert-card-unread")}
      onClick={() => {
        if (unread) onRead();
        onOpen();
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (unread) onRead();
          onOpen();
        }
      }}
    >
      <div className="desk-card-top">
        <div
          className="desk-thumb desk-thumb-fallback"
          style={{
            background: `${alertAccent(a.kind)}22`,
            color: alertAccent(a.kind),
            borderColor: `${alertAccent(a.kind)}44`,
          }}
        >
          {unread ? <BellRing className="w-4 h-4" /> : <Bell className="w-4 h-4 opacity-60" />}
        </div>
        <div className="desk-card-id min-w-0 flex-1">
          <div className="desk-card-title-row">
            <span
              className="desk-badge"
              style={{
                color: alertAccent(a.kind),
                background: `${alertAccent(a.kind)}14`,
                borderColor: `${alertAccent(a.kind)}40`,
              }}
            >
              {a.label}
            </span>
            {a.grade && (
              <span className="desk-badge desk-badge-mute">
                {a.grade}{a.score != null ? ` ${a.score}` : ""}
              </span>
            )}
            {a.telegramSent && <span className="desk-badge desk-badge-buy">TG</span>}
            {unread && <span className="desk-badge desk-badge-buy">New</span>}
          </div>
          <h3 className="desk-card-sym mt-1">${sym}</h3>
          <p className="desk-card-sub">{a.title.replace(/^\$\S+\s*/, "") || a.body || "—"}</p>
        </div>
        {gmgn && (
          <a
            href={gmgn}
            target="_blank"
            rel="noreferrer"
            className="desk-card-chart"
            aria-label={`Chart ${sym}`}
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="w-4 h-4" />
          </a>
        )}
      </div>

      <div className="desk-card-meta">
        <span>{formatTimeAgo(a.createdAt)}</span>
        {a.mcAtDetection != null && <span>Detect {formatCompactUsd(a.mcAtDetection)}</span>}
        {a.marketCapUsd != null && <span>Now {formatCompactUsd(a.marketCapUsd)}</span>}
        {a.gainPct != null && (
          <span className={a.gainPct >= 0 ? "is-gain" : "is-loss"}>
            {a.gainPct >= 0 ? "+" : ""}{a.gainPct.toFixed(0)}%
          </span>
        )}
      </div>
    </article>
  );
}

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
    refetchInterval: connected ? 90_000 : 25_000,
    staleTime: connected ? 20_000 : 8_000,
  });

  const feedQ = useQuery({
    queryKey: ALERTS_FEED_KEY(page, unreadOnly, kind),
    queryFn: () => fetchAlerts({ page, limit: PAGE_SIZE, unread: unreadOnly, kind: kind || undefined }),
    refetchInterval: connected ? 120_000 : 20_000,
    staleTime: connected ? 15_000 : 5_000,
    placeholderData: (prev) => prev,
    retry: 2,
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
  const pages = feedQ.data?.pages ?? 1;
  const showLoading = feedQ.isLoading && alerts.length === 0;

  const enableBrowserPush = async () => {
    if (typeof Notification === "undefined") return;
    const perm = await Notification.requestPermission();
    setNotifState(perm);
  };

  return (
    <div className="desk-page">
      <div className="desk-toolbar">
        <div className="desk-settings-head" style={{ padding: 0, margin: 0 }}>
          <h1 className="desk-settings-title flex items-center gap-2">
            <BellRing className="w-4 h-4 text-[var(--cryp-accent)]" />
            Alerts
          </h1>
          <p className="desk-settings-sub">
            {unread} unread · {stats?.telegramSent ?? "—"} TG · {connected ? "Live" : "Sync"}
          </p>
        </div>

        <div className="desk-panel-actions" style={{ border: 0, padding: "4px 0 0" }}>
          {notifState !== "granted" && notifState !== "unsupported" && (
            <button type="button" className="desk-btn" onClick={() => void enableBrowserPush()}>
              Enable push
            </button>
          )}
          {notifState === "granted" && (
            <span className="text-[11px] text-[var(--cryp-gain)] flex items-center gap-1">
              <Radio className="w-3 h-3" /> Browser on
            </span>
          )}
          {unread > 0 && (
            <button
              type="button"
              className="desk-btn"
              onClick={() => readMut.mutate({ all: true })}
              disabled={readMut.isPending}
            >
              <CheckCheck className="w-3.5 h-3.5" />
              Mark all read
            </button>
          )}
        </div>

        <div className="desk-card-metrics alert-stats">
          <div>
            <div className="desk-metric-label">Total</div>
            <div className="desk-metric-val">{stats?.total ?? "—"}</div>
          </div>
          <div>
            <div className="desk-metric-label">Unread</div>
            <div className="desk-metric-val is-gain">{unread}</div>
          </div>
          <div>
            <div className="desk-metric-label">Buy</div>
            <div className="desk-metric-val">{stats?.strongBuy ?? 0}</div>
          </div>
          <div>
            <div className="desk-metric-label">Milestones</div>
            <div className="desk-metric-val">{stats?.milestones ?? 0}</div>
          </div>
        </div>

        <div className="desk-chips" role="tablist" aria-label="Alert kinds">
          {KIND_FILTERS.map((f) => (
            <button
              key={f.id || "all"}
              type="button"
              role="tab"
              aria-selected={kind === f.id}
              onClick={() => { setKind(f.id); setPage(1); }}
              className={cn("desk-chip", kind === f.id && "desk-chip-on")}
            >
              {f.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => { setUnreadOnly((v) => !v); setPage(1); }}
            className={cn("desk-chip", unreadOnly && "desk-chip-on")}
          >
            Unread
          </button>
        </div>
      </div>

      <div className="desk-feed">
        {showLoading && (
          <>
            <div className="desk-card desk-skeleton" />
            <div className="desk-card desk-skeleton" />
          </>
        )}
        {feedQ.isError && (
          <div className="desk-empty">
            <p>Couldn’t load alerts</p>
            <button type="button" className="desk-btn" onClick={() => void feedQ.refetch()}>
              Retry
            </button>
          </div>
        )}
        {!showLoading && !feedQ.isError && alerts.length === 0 && (
          <div className="desk-empty">
            <p>No alerts yet</p>
            <p className="muted">Buy, Intra, S/A, EEI, and gain milestones land here + Telegram</p>
          </div>
        )}
        {alerts.map((a) => (
          <AlertCard
            key={a.id}
            a={a}
            onOpen={() => setLocation(`/calls/${a.tokenId}`)}
            onRead={() => readMut.mutate({ ids: [a.id] })}
          />
        ))}
      </div>

      {pages > 1 && (
        <div className="desk-pager">
          <button
            type="button"
            className="desk-btn"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="w-4 h-4" /> Prev
          </button>
          <span className="font-mono-num">{page} / {pages}</span>
          <button
            type="button"
            className="desk-btn"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
