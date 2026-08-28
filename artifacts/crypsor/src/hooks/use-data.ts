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
  payloadListeners: Set<(data: unknown) => void>;
  pending: ReturnType<typeof setTimeout> | null;
};

let shared: Shared | null = null;

function bump(s: Shared): void {
  const fire = () => {
    s.pending = null;
    for (const fn of s.listeners) fn();
  };
  if (s.pending) return;
  s.pending = setTimeout(fire, 250);
}

function acquire(
  onTick: () => void,
  onConn: (on: boolean) => void,
  onPayload?: (data: unknown) => void,
): () => void {
  if (!shared) {
    const es = new EventSource(sseUrl());
    const s: Shared = {
      es, n: 0, connected: false,
      listeners: new Set(), connListeners: new Set(), payloadListeners: new Set(), pending: null,
    };
    es.addEventListener("connected", () => {
      s.connected = true;
      for (const fn of s.connListeners) fn(true);
    });
    es.onerror = () => {
      s.connected = false;
      for (const fn of s.connListeners) fn(false);
    };
    for (const ev of ["alert:new", "vitals:tick", "watch:update", "desk:update", "agent:note", "stats:live", "pass:new", "archive:tick"]) {
      es.addEventListener(ev, (e) => {
        if (ev === "stats:live" && e instanceof MessageEvent) {
          try {
            const data = JSON.parse(String(e.data));
            for (const fn of s.payloadListeners) fn(data);
          } catch { /* ignore */ }
          return;
        }
        bump(s);
      });
    }
    shared = s;
  }
  shared.n += 1;
  shared.listeners.add(onTick);
  shared.connListeners.add(onConn);
  if (onPayload) shared.payloadListeners.add(onPayload);
  onConn(shared.connected);
  return () => {
    if (!shared) return;
    shared.listeners.delete(onTick);
    shared.connListeners.delete(onConn);
    if (onPayload) shared.payloadListeners.delete(onPayload);
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

/** Live stats board — SSE payload is the source of truth; poll only when the socket drops. */
export function useLiveBoard<T>(fetcher: () => Promise<T>): {
  data: T | null; error: string | null; loading: boolean; connected: boolean;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    fetcher()
      .then((d) => { if (alive.current) { setData(d); setError(null); } })
      .catch((e: unknown) => { if (alive.current) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive.current) setLoading(false); });

    let poll: ReturnType<typeof setInterval> | null = null;
    const startPoll = () => {
      if (poll) return;
      poll = setInterval(() => {
        fetcher()
          .then((d) => { if (alive.current) { setData(d); setError(null); } })
          .catch(() => { /* keep last frame */ });
      }, 8_000);
    };
    const stopPoll = () => {
      if (poll) { clearInterval(poll); poll = null; }
    };

    const release = acquire(
      () => {
        fetcher()
          .then((d) => { if (alive.current) { setData(d); setError(null); } })
          .catch(() => { /* keep last frame */ });
      },
      (on) => {
        setConnected(on);
        if (on) stopPoll();
        else startPoll();
      },
      (payload) => {
        if (alive.current) {
          setData(payload as T);
          setError(null);
          setLoading(false);
        }
      },
    );

    return () => {
      alive.current = false;
      stopPoll();
      release();
    };
  }, []);

  return { data, error, loading, connected };
}
