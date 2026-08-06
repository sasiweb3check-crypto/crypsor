/**
 * In-process event bus + SSE gateway. One EventSource per client;
 * events: call:new, journal:tick, funnel:activity.
 */
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";

export const bus = new EventEmitter();
bus.setMaxListeners(100);

const clients = new Set<Response>();

export function sseHandler(req: Request, res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: connected\ndata: {"ok":true}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(":ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

export function emitSse(event: string, data: unknown): void {
  bus.emit(event, data);
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}
