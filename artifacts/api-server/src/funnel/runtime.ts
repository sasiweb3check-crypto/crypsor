/**
 * Scheduler — runs the funnel loops while the instance is warm.
 *
 * Render Starter: this process stays up, so the intervals below are the
 * real scheduler. Vercel Hobby / Render free freeze without traffic, so
 * /keepalive + an external pinger (see docs/UPTIME.md) keep those hot.
 * Every loop is also runnable as a single bounded tick via runFullTick().
 */
import { ensureSchema } from "../core/db";
import { logger } from "../core/log";
import { discoveryTick } from "./discovery";
import { trackerTick } from "./tracker";
import { journalTick, pruneOld } from "./journal";

const log = logger.child({ module: "runtime" });

let started = false;
let bootPromise: Promise<void> | null = null;
let lastDiscovery = 0;
let lastTracker = 0;
let lastJournal = 0;
let lastPrune = 0;

const DISCOVERY_MS = 30_000;
const TRACKER_MS = 20_000;
const JOURNAL_MS = 30_000;
const PRUNE_MS = 30 * 60_000;

let discoveryRunning = false;
let trackerRunning = false;
let journalRunning = false;

async function guarded(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.warn({ err }, `${name} tick failed`);
  }
}

export async function ensureRuntime(): Promise<void> {
  if (started) return;
  if (!bootPromise) {
    bootPromise = (async () => {
      await ensureSchema();
      setInterval(() => {
        if (discoveryRunning || Date.now() - lastDiscovery < DISCOVERY_MS) return;
        discoveryRunning = true;
        lastDiscovery = Date.now();
        void guarded("discovery", discoveryTick).finally(() => { discoveryRunning = false; });
      }, 5_000);
      setInterval(() => {
        if (trackerRunning || Date.now() - lastTracker < TRACKER_MS) return;
        trackerRunning = true;
        lastTracker = Date.now();
        void guarded("tracker", trackerTick).finally(() => { trackerRunning = false; });
      }, 5_000);
      setInterval(() => {
        if (journalRunning || Date.now() - lastJournal < JOURNAL_MS) return;
        journalRunning = true;
        lastJournal = Date.now();
        void guarded("journal", journalTick).finally(() => { journalRunning = false; });
      }, 5_000);
      setInterval(() => {
        if (Date.now() - lastPrune < PRUNE_MS) return;
        lastPrune = Date.now();
        void guarded("prune", pruneOld);
      }, 60_000);
      started = true;
      log.info("funnel runtime started (discovery 30s · tracker 20s · journal 30s)");
    })().catch((err) => {
      bootPromise = null;
      throw err;
    });
  }
  return bootPromise;
}

/** One bounded pass of every stage — used by /cron/tick and /keepalive. */
export async function runFullTick(): Promise<Record<string, unknown>> {
  await ensureRuntime();
  const out: Record<string, unknown> = {};
  await guarded("discovery", async () => { out.discovery = await discoveryTick(); });
  await guarded("tracker", async () => { out.tracker = await trackerTick(); });
  await guarded("journal", async () => { out.journal = await journalTick(); });
  return out;
}
