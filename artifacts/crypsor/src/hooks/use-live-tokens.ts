/**
 * useLiveTokens
 *
 * Opens SSE to /api/events and patches React Query caches in real-time.
 * - calls:changed → Waiting/Best insert/surface/ENTRY
 * - prices:desk → patch MC/gain on Calls desk without waiting for poll
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getApiBase } from "@/lib/api-base";
import type { CallCard, FeedPage } from "@/lib/calls-api";

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

  return {
    ...card,
    currentMcUsd,
    athMcUsd: athMcUsd != null && Number.isFinite(athMcUsd) ? athMcUsd : card.athMcUsd,
    gainPct,
    nowMultiple: Number.isFinite(nowMultiple) ? nowMultiple : card.nowMultiple,
    athMultiple: Number.isFinite(athMultiple) ? athMultiple : card.athMultiple,
  };
}

export function useLiveTokens(): { connected: boolean } {
  const qc = useQueryClient();
  const connectedRef = useRef(false);
  const callsBumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    };

    es.addEventListener("connected", () => {
      connectedRef.current = true;
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
      } catch { /* ignore */ }
    });

    es.addEventListener("holders:updated", (e: MessageEvent) => {
      try {
        const payload: { tokenId: number } = JSON.parse(e.data);
        qc.invalidateQueries({ queryKey: ["holders", payload.tokenId] });
      } catch { /* ignore */ }
    });

    es.onerror = () => {
      connectedRef.current = false;
    };

    return () => {
      if (callsBumpTimer.current) clearTimeout(callsBumpTimer.current);
      es.close();
      connectedRef.current = false;
    };
  }, [qc]);

  return { connected: connectedRef.current };
}
