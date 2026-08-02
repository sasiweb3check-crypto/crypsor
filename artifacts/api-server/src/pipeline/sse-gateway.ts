/**
 * SSE Gateway (Server-Sent Events)
 *
 * Pushes real-time token updates to connected dashboard clients.
 * No polling needed — the dashboard subscribes once and receives diffs.
 *
 * Events emitted to clients:
 *   token:updated  — when projection is recomputed (gain%, buyPressure, status)
 *   token:sold     — when a tracked wallet sells
 *   ping           — keepalive every 25 s
 *
 * Usage:
 *   GET /api/events   (text/event-stream)
 */

import type { Request, Response } from "express";
import { eventBus } from "./event-bus";
import { logger } from "../lib/logger";

interface SseClient {
  id: string;
  res: Response;
}

const clients = new Map<string, SseClient>();

let clientSeq = 0;

function sendEvent(client: SseClient, event: string, data: unknown): void {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    clients.delete(client.id);
  }
}

function broadcast(event: string, data: unknown): void {
  for (const client of clients.values()) {
    sendEvent(client, event, data);
  }
}

/** Express route handler — mount at GET /api/events */
export function sseHandler(req: Request, res: Response): void {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
  res.flushHeaders();

  const id = `c${++clientSeq}`;
  const client: SseClient = { id, res };
  clients.set(id, client);

  logger.debug({ id, total: clients.size }, "SSE client connected");

  // Send initial ack
  res.write(`event: connected\ndata: {"clientId":"${id}"}\n\n`);

  // Keepalive ping every 25 s (prevents proxy timeouts)
  const pingInterval = setInterval(() => {
    try { res.write(`:ping\n\n`); } catch { clients.delete(id); clearInterval(pingInterval); }
  }, 25_000);

  req.on("close", () => {
    clients.delete(id);
    clearInterval(pingInterval);
    logger.debug({ id, total: clients.size }, "SSE client disconnected");
  });
}

/** Wire up event bus → SSE broadcast */
export function startSseGateway(): void {
  eventBus.on("projection:updated", (evt) => {
    broadcast("token:updated", {
      tokenId:      evt.tokenId,
      tokenAddress: evt.tokenAddress,
      gainPct:      evt.gainPct,
      athGainPct:   evt.athGainPct,
      buyPressure:  evt.buyPressure,
      status:       evt.status,
    });
  });

  eventBus.on("token:sold", (evt) => {
    broadcast("token:sold", {
      tokenId:      evt.tokenId,
      tokenAddress: evt.tokenAddress,
      soldAt:       evt.soldAt,
    });
  });

  eventBus.on("token:deleted", (evt) => {
    broadcast("token:deleted", {
      tokenId:      evt.tokenId,
      tokenAddress: evt.tokenAddress,
    });
  });

  eventBus.on("holders:updated", (evt) => {
    broadcast("holders:updated", {
      tokenId:      evt.tokenId,
      tokenAddress: evt.tokenAddress,
      count:        evt.count,
      source:       evt.source,
    });
  });

  // Rich feed events — forwarded as-is to the live tape
  eventBus.on("feed:item", (evt) => {
    broadcast("feed:event", evt);
  });

  // Waiting / Best desk — push immediately so clients invalidate feed caches
  eventBus.on("calls:changed", (evt) => {
    broadcast("calls:changed", {
      reason: evt.reason,
      tokenId: evt.tokenId,
      symbol: evt.symbol ?? null,
      qualityLabel: evt.qualityLabel ?? null,
      at: evt.at ?? new Date().toISOString(),
    });
  });

  logger.info("SSE gateway started");
}

export function connectedClientCount(): number {
  return clients.size;
}
