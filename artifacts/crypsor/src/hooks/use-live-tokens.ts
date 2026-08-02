/**
 * useLiveTokens
 *
 * Opens SSE to /api/events and patches React Query caches in real-time.
 * Also invalidates Calls desk (Waiting/Best/Hot/Latest) on calls:changed
 * so new Waiting rows appear without waiting for the poll interval.
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getApiBase } from "@/lib/api-base";

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

interface PaginatedTokenPage {
  data: Record<string, unknown>[];
  total: number;
  page: number;
  pages: number;
}

export function useLiveTokens(): { connected: boolean } {
  const qc = useQueryClient();
  const connectedRef = useRef(false);
  const callsBumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callsPriceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const url = `${getApiBase()}api/events`;
    const es = new EventSource(url);

    const bumpCallsDesk = (ms = 60) => {
      // Coalesce qualify bursts into one refetch; keep delay tiny for Waiting sync
      if (callsBumpTimer.current) clearTimeout(callsBumpTimer.current);
      callsBumpTimer.current = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ["calls-feed"] });
        void qc.invalidateQueries({ queryKey: ["calls-waiting"] });
        void qc.invalidateQueries({ queryKey: ["calls-stats"] });
        void qc.invalidateQueries({ queryKey: ["opsSummary"] });
      }, ms);
    };

    const bumpCallsPrices = () => {
      // Price ticks are frequent — soft refresh so Gain/MC stay live without thrash
      if (callsPriceTimer.current) return;
      callsPriceTimer.current = setTimeout(() => {
        callsPriceTimer.current = null;
        void qc.invalidateQueries({ queryKey: ["calls-feed"] });
      }, 2_500);
    };

    es.addEventListener("connected", () => {
      connectedRef.current = true;
    });

    es.addEventListener("calls:changed", () => {
      bumpCallsDesk(60);
    });

    // Patch the token in every cached paginated page
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

        bumpCallsPrices();
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
      if (callsPriceTimer.current) clearTimeout(callsPriceTimer.current);
      es.close();
      connectedRef.current = false;
    };
  }, [qc]);

  return { connected: connectedRef.current };
}
