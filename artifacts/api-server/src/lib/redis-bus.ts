/**
 * Redis pub/sub bridge for cross-process SSE event delivery.
 *
 * The worker process publishes SSE-relevant events here; the API process
 * subscribes and forwards them to connected browser clients via SSE.
 *
 * Channel: "crypsor:sse"
 * Message: JSON string { event: string; data: unknown }
 */

import { createRedisClient } from "./redis";
import type { Redis } from "ioredis";

const SSE_CHANNEL = "crypsor:sse";

// Lazily created publisher (shared across all publishSseEvent calls)
let _publisher: Redis | null = null;

function getPublisher(): Redis {
  if (!_publisher) {
    _publisher = createRedisClient("sse-publisher");
    _publisher.on("error", (err: unknown) =>
      console.error("[redis-bus] publisher error:", (err as Error).message ?? err),
    );
  }
  return _publisher;
}

/**
 * Publish an SSE-style event to the shared Redis channel.
 * Called by the worker process for every event that should reach browser clients.
 */
export function publishSseEvent(event: string, data: unknown): void {
  const msg = JSON.stringify({ event, data });
  getPublisher().publish(SSE_CHANNEL, msg).catch((err: unknown) =>
    console.error("[redis-bus] publish error:", (err as Error).message ?? err),
  );
}

/**
 * Subscribe to the SSE Redis channel and call `handler` for each message.
 * Returns the subscriber Redis client (for cleanup on shutdown).
 *
 * Called by the API process to receive events from the worker.
 */
export function subscribeToSseEvents(
  handler: (event: string, data: unknown) => void,
): Redis {
  const sub = createRedisClient("sse-subscriber");
  sub.subscribe(SSE_CHANNEL, (err) => {
    if (err) console.error("[redis-bus] subscribe error:", err.message);
  });
  sub.on("message", (_channel: string, message: string) => {
    try {
      const parsed = JSON.parse(message) as { event: string; data: unknown };
      handler(parsed.event, parsed.data);
    } catch {
      /* malformed message — ignore */
    }
  });
  return sub;
}
