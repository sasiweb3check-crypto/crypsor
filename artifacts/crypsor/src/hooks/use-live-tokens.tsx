/**
 * Live SSE — single EventSource for the whole desk.
 *
 * - calls:changed → Waiting/Best/Hot/Latest + pending badge
 * - prices:desk → patch MC/gain on feed + call detail (no poll wait)
 * - token:bought → bump buy counts, refresh detail buyers, desk feeds
 * - reconnect → invalidate desk (EventSource has no backlog)
 */

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getApiBase } from "@/lib/api-base";
import type { CallCard, CallBuyer, CallSnap, CrypsorWalletRow, FeedPage } from "@/lib/calls-api";

type CallDetailPayload = {
  card: CallCard | null;
  buyers: CallBuyer[];
  snaps: CallSnap[];
  crypsorWallets?: CrypsorWalletRow[];
  winrateLoaded?: boolean;
};

interface TokenUpdatedPayload {
  tokenId: number;
  tokenAddress: string;
  gainPct: number | null;
  athGainPct: number | null;
  buyPressure: number;
  status: string;
}

interface TokenSoldPayload {
  tokenId: number;
  tokenAddress: string;
  soldAt: string;
}

interface TokenDeletedPayload {
  tokenId: number;
  tokenAddress: string;
}

interface TokenBoughtPayload {
  tokenId: number;
  tokenAddress: string;
  walletId: number;
  boughtAt?: string;
}

interface PricesDeskPayload {
  ticks: Array<{
    tokenId: number;
    tokenAddress: string;
    marketCapUsd: string | null;
    athMarketCapUsd: string | null;
  }>;
  at: string;
}

interface PaginatedTokenPage {
  data: Record<string, unknown>[];
  total: number;
  page: number;
  pages: number;
}

type LiveSseValue = { connected: boolean };

const LiveSseContext = createContext<LiveSseValue>({ connected: false });

export function useLiveSse(): LiveSseValue {
  return useContext(LiveSseContext);
}

function patchCallCard(
  card: CallCard,
  tick: PricesDeskPayload["ticks"][number],
): CallCard {
  const currentMcUsd = tick.marketCapUsd != null && tick.marketCapUsd !== ""
    ? Number(tick.marketCapUsd)
    : card.currentMcUsd;
  if (currentMcUsd == null || !Number.isFinite(currentMcUsd)) return card;

  const called = card.calledMcUsd;
  let gainPct = card.gainPct;
  let nowMultiple = card.nowMultiple;
  if (called != null && called > 0) {
    nowMultiple = Math.round((currentMcUsd / called) * 100) / 100;
    gainPct = ((currentMcUsd - called) / called) * 100;
  }

  const athMcUsd = tick.athMarketCapUsd != null && tick.athMarketCapUsd !== ""
    ? Number(tick.athMarketCapUsd)
    : card.athMcUsd;
  let athMultiple = card.athMultiple;
  if (athMcUsd != null && Number.isFinite(athMcUsd) && called != null && called > 0) {
    athMultiple = Math.round((athMcUsd / called) * 100) / 100;
  }

  let gain1hPct = card.gain1hPct;
  const baseline1h = card.mc1hUsd;
  if (baseline1h != null && baseline1h > 0) {
    gain1hPct = Math.round(((currentMcUsd - baseline1h) / baseline1h) * 1000) / 10;
  } else if (
    gain1hPct != null
    && called != null
    && called > 0
    && card.calledAt
    && (Date.now() - new Date(card.calledAt).getTime()) / 60_000 < 90
  ) {
    gain1hPct = Math.round(((currentMcUsd - called) / called) * 1000) / 10;
  }

  const detectMc = card.pumpMcAtDetection;
  let pumpMcGainSinceDetection = card.pumpMcGainSinceDetection;
  let pumpGainSinceDetection = card.pumpGainSinceDetection;
  if (detectMc != null && detectMc > 0) {
    pumpMcGainSinceDetection = ((currentMcUsd - detectMc) / detectMc) * 100;
    pumpGainSinceDetection = pumpMcGainSinceDetection;
  }

  const athForPump = athMcUsd != null && Number.isFinite(athMcUsd) ? athMcUsd : card.athMcUsd;
  let pumpAthMcGain = card.pumpAthMcGain;
  let pumpAthGain = card.pumpAthGain;
  if (athForPump != null && detectMc != null && detectMc > 0) {
    pumpAthMcGain = ((athForPump - detectMc) / detectMc) * 100;
    pumpAthGain = pumpAthMcGain;
  }

  return {
    ...card,
    currentMcUsd,
    pumpMarketCap: currentMcUsd,
    athMcUsd: athForPump != null && Number.isFinite(athForPump) ? athForPump : card.athMcUsd,
    gainPct,
    gain1hPct,
    nowMultiple: Number.isFinite(nowMultiple) ? nowMultiple : card.nowMultiple,
    athMultiple: Number.isFinite(athMultiple) ? athMultiple : card.athMultiple,
    pumpMcGainSinceDetection,
    pumpGainSinceDetection,
    pumpAthMcGain,
    pumpAthGain,
  };
}

function useLiveTokensInternal(): LiveSseValue {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const callsBumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buyBumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alertBumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sawDisconnect = useRef(false);

  useEffect(() => {
    const url = `${getApiBase()}api/events`;
    const es = new EventSource(url);

    const bumpCallsDesk = (ms = 60) => {
      if (callsBumpTimer.current) clearTimeout(callsBumpTimer.current);
      callsBumpTimer.current = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ["calls-feed"] });
        void qc.invalidateQueries({ queryKey: ["calls-waiting"] });
        void qc.invalidateQueries({ queryKey: ["calls-stats"] });
        void qc.invalidateQueries({ queryKey: ["opsSummary"] });
      }, ms);
    };

    const bumpBuys = (tokenId: number, ms = 80) => {
      if (buyBumpTimer.current) clearTimeout(buyBumpTimer.current);
      buyBumpTimer.current = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ["calls-token", tokenId] });
        void qc.invalidateQueries({ queryKey: ["calls-feed"] });
        void qc.invalidateQueries({ queryKey: ["calls-waiting"] });
        void qc.invalidateQueries({ queryKey: ["opsSummary"] });
        void qc.invalidateQueries({ queryKey: ["opsLog"] });
      }, ms);
    };

    const bumpAlerts = (ms = 250) => {
      if (alertBumpTimer.current) clearTimeout(alertBumpTimer.current);
      alertBumpTimer.current = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ["pump-alerts"] });
        void qc.invalidateQueries({ queryKey: ["pump-alerts-stats"] });
        void qc.invalidateQueries({ queryKey: ["pump-alerts-unread"] });
      }, ms);
    };

    const applyDeskPrices = (payload: PricesDeskPayload) => {
      if (!payload.ticks?.length) return;
      const byId = new Map(payload.ticks.map((t) => [t.tokenId, t]));

      qc.setQueriesData<FeedPage>(
        { queryKey: ["calls-feed"] },
        (old) => {
          if (!old?.cards?.length) return old;
          let changed = false;
          const cards = old.cards.map((c) => {
            const tick = byId.get(c.id);
            if (!tick) return c;
            changed = true;
            return patchCallCard(c, tick);
          });
          return changed ? { ...old, cards } : old;
        },
      );

      // Patch open call-detail caches (any winrate flag)
      qc.setQueriesData<CallDetailPayload>(
        { queryKey: ["calls-token"] },
        (old) => {
          if (!old?.card) return old;
          const tick = byId.get(old.card.id);
          if (!tick) return old;
          return { ...old, card: patchCallCard(old.card, tick) };
        },
      );
    };

    es.addEventListener("connected", () => {
      setConnected(true);
      if (sawDisconnect.current) {
        bumpCallsDesk(0);
      }
    });

    es.addEventListener("calls:changed", () => {
      bumpCallsDesk(60);
    });

    es.addEventListener("prices:desk", (e: MessageEvent) => {
      try {
        applyDeskPrices(JSON.parse(e.data as string) as PricesDeskPayload);
      } catch (err) {
        console.warn("[SSE] prices:desk parse error", err);
      }
    });

    es.addEventListener("alert:pump", (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data as string) as {
          id: number;
          tokenId: number;
          kind: string;
          label: string;
          title: string;
          body: string | null;
          symbol: string | null;
          address: string | null;
        };
        bumpAlerts(200);

        // Browser notification center (OS banner)
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          try {
            const n = new Notification(payload.title || payload.label, {
              body: payload.body ?? payload.label,
              tag: `pump-alert-${payload.id}`,
            });
            n.onclick = () => {
              window.focus();
              window.location.href = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/calls/${payload.tokenId}`;
              n.close();
            };
          } catch (notifErr) {
            console.warn("[SSE] browser notification failed", notifErr);
          }
        }
      } catch (err) {
        console.warn("[SSE] alert:pump parse error", err);
      }
    });

    es.addEventListener("token:bought", (e: MessageEvent) => {
      try {
        const payload: TokenBoughtPayload = JSON.parse(e.data as string);
        // Optimistic buy-count bump on visible rows (distinct wallets — approx)
        qc.setQueriesData<FeedPage>(
          { queryKey: ["calls-feed"] },
          (old) => {
            if (!old?.cards?.length) return old;
            let changed = false;
            const cards = old.cards.map((c) => {
              if (c.id !== payload.tokenId) return c;
              changed = true;
              return { ...c, walletBuys: (c.walletBuys ?? 0) + 1 };
            });
            return changed ? { ...old, cards } : old;
          },
        );
        bumpBuys(payload.tokenId, 100);
      } catch (err) {
        console.warn("[SSE] token:bought parse error", err);
      }
    });

    es.addEventListener("token:updated", (e: MessageEvent) => {
      try {
        const payload: TokenUpdatedPayload = JSON.parse(e.data as string);

        qc.setQueriesData<PaginatedTokenPage>(
          { queryKey: ["tokens"], exact: false },
          (old) => {
            if (!old?.data) return old;
            const updated = old.data.map((t) =>
              t.id === payload.tokenId
                ? {
                    ...t,
                    detectionGainPct: payload.gainPct,
                    athGainPct: payload.athGainPct,
                    buyPressure: payload.buyPressure,
                    status: payload.status,
                  }
                : t,
            );
            return { ...old, data: updated };
          },
        );

        qc.setQueryData<Record<string, unknown>>(["token", payload.tokenId], (old) => {
          if (!old) return old;
          return {
            ...old,
            detectionGainPct: payload.gainPct,
            athGainPct: payload.athGainPct,
            buyPressure: payload.buyPressure,
            status: payload.status,
          };
        });
      } catch (err) {
        console.warn("[SSE] token:updated parse error", err);
      }
    });

    es.addEventListener("token:deleted", (e: MessageEvent) => {
      try {
        const payload: TokenDeletedPayload = JSON.parse(e.data as string);

        qc.setQueriesData<PaginatedTokenPage>(
          { queryKey: ["tokens"], exact: false },
          (old) => {
            if (!old?.data) return old;
            const filtered = old.data.filter((t) => t.id !== payload.tokenId);
            const removed = old.data.length - filtered.length;
            if (removed === 0) return old;
            return {
              ...old,
              data: filtered,
              total: Math.max(0, old.total - removed),
            };
          },
        );

        qc.invalidateQueries({ queryKey: ["dashboard"] });
        bumpCallsDesk(60);
      } catch { /* ignore */ }
    });

    es.addEventListener("token:sold", (e: MessageEvent) => {
      try {
        const payload: TokenSoldPayload = JSON.parse(e.data);
        qc.invalidateQueries({ queryKey: ["token", payload.tokenId] });
        qc.invalidateQueries({ queryKey: ["calls-token", payload.tokenId] });
      } catch { /* ignore */ }
    });

    es.addEventListener("holders:updated", (e: MessageEvent) => {
      try {
        const payload: { tokenId: number } = JSON.parse(e.data);
        qc.invalidateQueries({ queryKey: ["holders", payload.tokenId] });
        qc.invalidateQueries({ queryKey: ["calls-token", payload.tokenId] });
      } catch { /* ignore */ }
    });

    es.onerror = () => {
      sawDisconnect.current = true;
      setConnected(false);
    };

    return () => {
      if (callsBumpTimer.current) clearTimeout(callsBumpTimer.current);
      if (buyBumpTimer.current) clearTimeout(buyBumpTimer.current);
      if (alertBumpTimer.current) clearTimeout(alertBumpTimer.current);
      es.close();
      setConnected(false);
    };
  }, [qc]);

  return { connected };
}

/** Mount once in AppShell — provides connected flag + wires SSE. */
export function LiveSseProvider({ children }: { children: ReactNode }) {
  const value = useLiveTokensInternal();
  return (
    <LiveSseContext.Provider value={value}>
      {children}
    </LiveSseContext.Provider>
  );
}

/** @deprecated Prefer useLiveSse() — kept for any leftover imports. */
export function useLiveTokens(): LiveSseValue {
  return useLiveSse();
}
