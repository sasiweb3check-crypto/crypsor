/**
 * Omo desk runtime — wallet-buy discovery, then the omo read → gate → book loop.
 *
 *   intake   tracked-wallet buys (Helius) — the only discovery source
 *   vitals   DexScreener tape + pump.fun callback + omo gate
 *   book     omo exit rules on locked names
 *   reporter census + prune
 *
 * Debate, dual snapshots, GMGN-required lock, and backtest weights are gone.
 * Render Starter: this process stays up, so the intervals below are the scheduler.
 */
import { ensureSchema } from "../core/db";
import { logger } from "../core/log";
import { intakeTick } from "../agents/intake";
import { vitalsTick } from "../agents/vitals";
import { bookTick } from "../agents/book";
import { reporterTick } from "../agents/reporter";

const log = logger.child({ module: "runtime" });

let started = false;
let bootPromise: Promise<void> | null = null;

const INTAKE_MS = 40_000;
const VITALS_MS = 22_000;
const BOOK_MS = 40_000;
const REPORT_MS = 120_000;

let last = { intake: 0, vitals: 0, book: 0, reporter: 0 };
let running = { intake: false, vitals: false, book: false, reporter: false };

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
      setInterval(() => {
        if (running.intake || Date.now() - last.intake < INTAKE_MS) return;
        running.intake = true;
        last.intake = Date.now();
        void guarded("intake", intakeTick).finally(() => { running.intake = false; });
      }, 5_000);
      setInterval(() => {
        if (running.vitals || Date.now() - last.vitals < VITALS_MS) return;
        running.vitals = true;
        last.vitals = Date.now();
        void guarded("vitals", vitalsTick).finally(() => { running.vitals = false; });
      }, 5_000);
      setInterval(() => {
        if (running.book || Date.now() - last.book < BOOK_MS) return;
        running.book = true;
        last.book = Date.now();
        void guarded("book", bookTick).finally(() => { running.book = false; });
      }, 8_000);
      setInterval(() => {
        if (running.reporter || Date.now() - last.reporter < REPORT_MS) return;
        running.reporter = true;
        last.reporter = Date.now();
        void guarded("reporter", reporterTick).finally(() => { running.reporter = false; });
      }, 15_000);
      started = true;
      log.info("omo desk started (intake · vitals/gate · book · reporter)");
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
    intervalsMs: {
      intake: INTAKE_MS,
      vitals: VITALS_MS,
      book: BOOK_MS,
      reporter: REPORT_MS,
    },
  };
}

export async function runFullTick(): Promise<Record<string, unknown>> {
  await ensureRuntime();
  const out: Record<string, unknown> = {};
  await guarded("intake", async () => { out.intake = await intakeTick(); });
  await guarded("vitals", async () => { out.vitals = await vitalsTick(); });
  await guarded("book", async () => { out.book = await bookTick(); });
  await guarded("reporter", async () => { out.reporter = await reporterTick(); });
  return out;
}
