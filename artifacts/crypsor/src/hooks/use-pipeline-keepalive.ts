/**
 * Soft pipeline wake — hobby/free Vercel has no sub-daily cron.
 * While the desk tab is open we ping /api/keepalive so Fluid instances
 * keep scanning. Optional: point a free external cron at /api/cron/tick.
 */
import { useEffect } from "react";
import { apiFetch } from "@/lib/api-fetch";

const INTERVAL_MS = 60_000;

export function usePipelineKeepalive(enabled = true) {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    let cancelled = false;
    const ping = () => {
      if (cancelled || document.visibilityState === "hidden") return;
      void apiFetch("api/keepalive", { timeoutMs: 55_000 }).catch(() => {
        /* ignore — next tick retries */
      });
    };

    ping();
    const id = window.setInterval(ping, INTERVAL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") ping();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [enabled]);
}
