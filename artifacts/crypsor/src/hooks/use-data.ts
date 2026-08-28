/**
 * Data hooks — one shared EventSource, throttled refresh.
 * SSE is the live path; polling is a slow safety net.
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

type Shared = {
  es: EventSource;
  n: number;
  connected: boolean;
  listeners: Set<() => void>;
  connListeners: Set<(on: boolean) => void>;
  pending: ReturnType<typeof setTimeout> | null;
};

let shared: Shared | null = null;

function bump(s: Shared): void {
  const fire = () => {
    s.pending = null;
    for (const fn of s.listeners) fn();
  };
  if (s.pending) return;
  s.pending = setTimeout(fire, 800);
}

function acquire(onTick: () => void, onConn: (on: boolean) => void): () => void {
  if (!shared) {
    const es = new EventSource(sseUrl());
    const s: Shared = {
      es, n: 0, connected: false,
      listeners: new Set(), connListeners: new Set(), pending: null,
    };
    es.addEventListener("connected", () => {
      s.connected = true;
      for (const fn of s.connListeners) fn(true);
    });
    es.onerror = () => {
      s.connected = false;
      for (const fn of s.connListeners) fn(false);
    };
    for (const ev of ["alert:new", "vitals:tick", "watch:update", "desk:update", "agent:note"]) {
      es.addEventListener(ev, () => bump(s));
    }
    shared = s;
  }
  shared.n += 1;
  shared.listeners.add(onTick);
  shared.connListeners.add(onConn);
  onConn(shared.connected);
  return () => {
    if (!shared) return;
    shared.listeners.delete(onTick);
    shared.connListeners.delete(onConn);
    shared.n -= 1;
    if (shared.n <= 0) {
      if (shared.pending) clearTimeout(shared.pending);
      shared.es.close();
      shared = null;
    }
  };
}

/** Shared EventSource across pages. Tick is throttled so vitals do not thrash fetches. */
export function useSse(_events?: string[]): { connected: boolean; tick: number } {
  const [connected, setConnected] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    try {
      return acquire(
        () => setTick((t) => t + 1),
        (on) => setConnected(on),
      );
    } catch {
      return;
    }
  }, []);

  return { connected, tick };
}
