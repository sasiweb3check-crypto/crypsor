/**
 * Data hooks — polling with SSE-triggered refresh. No query lib needed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { sseUrl } from "../lib/api";

export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  deps: unknown[] = [],
): { data: T | null; error: string | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

  const load = useCallback(() => {
    fetcher()
      .then((d) => { if (alive.current) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (alive.current) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    load();
    const t = setInterval(load, intervalMs);
    return () => { alive.current = false; clearInterval(t); };
  }, [load, intervalMs]);

  return { data, error, loading, refresh: load };
}

/** Single shared EventSource; returns connected flag + event tick counter. */
export function useSse(events: string[]): { connected: boolean; tick: number } {
  const [connected, setConnected] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource(sseUrl());
    } catch {
      return;
    }
    es.addEventListener("connected", () => setConnected(true));
    es.onerror = () => setConnected(false);
    for (const ev of events) {
      es.addEventListener(ev, () => setTick((t) => t + 1));
    }
    return () => { es?.close(); setConnected(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.join(",")]);

  return { connected, tick };
}
