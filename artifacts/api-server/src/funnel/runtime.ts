/**
 * Desk runtime — wallet buys in, 15-minute MC prints, nothing else.
 */
import { ensureSchema } from "../core/db";
import { logger } from "../core/log";
import { intakeTick } from "../agents/intake";
import { scanTick } from "../agents/scan";
import { scrubReceives } from "../agents/scrub";
import { scoutTick } from "../agents/scout";

const log = logger.child({ module: "runtime" });

let started = false;
let bootPromise: Promise<void> | null = null;

const INTAKE_MS = 40_000;
const SCAN_CHECK_MS = 30_000;
const SCRUB_MS = 10 * 60_000;
const SCAN_EVERY_MS = 15 * 60_000;

let last = { intake: 0, scan: 0, scrub: 0, scout: 0 };
let running = { intake: false, scan: false, scrub: false, scout: false };

async function guarded(name: keyof typeof running, fn: () => Promise<unknown>): Promise<void> {
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
      void guarded("scrub", () => scrubReceives());
      void guarded("scan", scanTick).then(() => { last.scan = Date.now(); });
      setInterval(() => {
        if (running.intake || Date.now() - last.intake < INTAKE_MS) return;
        running.intake = true;
        last.intake = Date.now();
        void guarded("intake", intakeTick).finally(() => { running.intake = false; });
      }, 5_000);
      setInterval(() => {
        if (running.scan) return;
        running.scan = true;
        void guarded("scan", scanTick).finally(() => {
          running.scan = false;
          last.scan = Date.now();
        });
      }, SCAN_CHECK_MS);
      setInterval(() => {
        if (running.scrub || Date.now() - last.scrub < SCRUB_MS) return;
        running.scrub = true;
        last.scrub = Date.now();
        void guarded("scrub", scrubReceives).finally(() => { running.scrub = false; });
      }, 30_000);
      setInterval(() => {
        if (running.scout) return;
        running.scout = true;
        void guarded("scout", scoutTick).finally(() => {
          running.scout = false;
          last.scout = Date.now();
        });
      }, 8_000);
      started = true;
      log.info("desk started — wallet buys · 50s MC while young/running · 15m otherwise");
    })().catch((err) => {
      bootPromise = null;
      throw err;
    });
  }
  return bootPromise;
}

export function agentStatus(): {
  started: boolean;
  last: typeof last;
  running: typeof running;
  intervalsMs: Record<string, number>;
} {
  return {
    started,
    last: { ...last },
    running: { ...running },
    intervalsMs: { intake: INTAKE_MS, scan: SCAN_EVERY_MS, scanFast: 50_000, scrub: SCRUB_MS, scout: 8_000 },
  };
}

export async function runFullTick(): Promise<Record<string, unknown>> {
  await ensureRuntime();
  const out: Record<string, unknown> = {};
  await guarded("intake", async () => { out.intake = await intakeTick(); });
  await guarded("scan", async () => { out.scan = await scanTick(); });
  await guarded("scrub", async () => { out.scrub = await scrubReceives(); });
  await guarded("scout", async () => { out.scout = await scoutTick(); });
  return out;
}
