/**
 * useLiveTokens
 *
 * Opens a Server-Sent Events connection to /api/events and patches the
 * React Query cache in real-time. Dashboard components re-render immediately
 * when token:updated, token:sold, or token:deleted events arrive.
 *
 * With server-side pagination the list lives under ["tokens", ...params].
 * On token:updated  → patch in-place across all cached pages.
 * On token:deleted  → remove from all cached pages and decrement total.
 * On token:sold     → invalidate the affected detail query only.
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

interface TokenUpdatedPayload {
  tokenId:      number;
  tokenAddress: string;
  gainPct:      number | null;
  athGainPct:   number | null;
  buyPressure:  number;
  status:       string;
}

interface TokenSoldPayload {
  tokenId:      number;
  tokenAddress: string;
  soldAt:       string;
}

interface TokenDeletedPayload {
  tokenId:      number;
  tokenAddress: string;
}

interface PaginatedTokenPage {
  data:  Record<string, unknown>[];
  total: number;
  page:  number;
  pages: number;
}

export function useLiveTokens(): { connected: boolean } {
  const qc = useQueryClient();
  const connectedRef = useRef(false);

  useEffect(() => {
    const rawBase = import.meta.env.VITE_API_URL ?? import.meta.env.BASE_URL ?? "/";
    const base = rawBase.endsWith("/") ? rawBase : `${rawBase}/`;
    const url  = `${base}api/events`;
    const es   = new EventSource(url);

    es.addEventListener("connected", () => {
      connectedRef.current = true;
    });

    // Patch the token in every cached paginated page
    es.addEventListener("token:updated", (e: MessageEvent) => {
      try {
        const payload: TokenUpdatedPayload = JSON.parse(e.data as string);

        // Update across all paginated token list queries
        qc.setQueriesData<PaginatedTokenPage>(
          { queryKey: ["tokens"], exact: false },
          (old) => {
            if (!old?.data) return old;
            const updated = old.data.map((t) =>
              t.id === payload.tokenId
                ? {
                    ...t,
                    detectionGainPct: payload.gainPct,
                    athGainPct:       payload.athGainPct,
                    buyPressure:      payload.buyPressure,
                    status:           payload.status,
                  }
                : t,
            );
            return { ...old, data: updated };
          },
        );

        // Patch single-token detail if open
        qc.setQueryData<Record<string, unknown>>(["token", payload.tokenId], (old) => {
          if (!old) return old;
          return {
            ...old,
            detectionGainPct: payload.gainPct,
            athGainPct:       payload.athGainPct,
            buyPressure:      payload.buyPressure,
            status:           payload.status,
          };
        });
      } catch (err) { console.warn("[SSE] token:updated parse error", err); }
    });

    // Remove deleted token from all cached pages; invalidate dashboard counts
    es.addEventListener("token:deleted", (e: MessageEvent) => {
      try {
        const payload: TokenDeletedPayload = JSON.parse(e.data as string);

        qc.setQueriesData<PaginatedTokenPage>(
          { queryKey: ["tokens"], exact: false },
          (old) => {
            if (!old?.data) return old;
            const filtered = old.data.filter((t) => t.id !== payload.tokenId);
            const removed  = old.data.length - filtered.length;
            if (removed === 0) return old;
            return {
              ...old,
              data:  filtered,
              total: Math.max(0, old.total - removed),
            };
          },
        );

        // Refresh dashboard stat counts
        qc.invalidateQueries({ queryKey: ["dashboard"] });
      } catch {}
    });

    es.addEventListener("token:sold", (e: MessageEvent) => {
      try {
        const payload: TokenSoldPayload = JSON.parse(e.data);
        // Invalidate to trigger a fresh fetch that includes the new sell
        qc.invalidateQueries({ queryKey: ["token", payload.tokenId] });
      } catch {}
    });

    // Invalidate the DB-backed holders cache for this token so the detail
    // page refreshes automatically when the background worker finishes a sync.
    es.addEventListener("holders:updated", (e: MessageEvent) => {
      try {
        const payload: { tokenId: number } = JSON.parse(e.data);
        qc.invalidateQueries({ queryKey: ["holders", payload.tokenId] });
      } catch {}
    });

    es.onerror = () => {
      connectedRef.current = false;
      // EventSource auto-reconnects; no manual retry needed
    };

    return () => {
      es.close();
      connectedRef.current = false;
    };
  }, [qc]);

  return { connected: connectedRef.current };
}
