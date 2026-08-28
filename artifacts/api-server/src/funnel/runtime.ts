/**
 * Ward runtime — dedicated in-process agents (free-tier: one Node process).
 *
 *   intake   wallet buys only (Helius)
 *   vitals   DexScreener/pump tape + scoring + phase
 *   holders  GMGN quality (rate-limited)
 *   reporter census
 *   backtest self-improving weights from TRADE outcomes
 */
import { ensureSchema } from "../core/db";
import { logger } from "../core/log";
import { intakeTick } from "../agents/intake";
import { vitalsTick } from "../agents/vitals";
import { holdersTick } from "../agents/holders";
import { reporterTick } from "../agents/reporter";
import { backtestTick, loadWeights } from "../agents/backtest";

const log = logger.child({ module: "runtime" });

let started = false;
let bootPromise: Promise<void> | null = null;

const INTAKE_MS = 40_000;
const VITALS_MS = 22_000;
const HOLDERS_MS = 90_000;
const REPORT_MS = 120_000;
const BACKTEST_MS = 10 * 60_000;

let last = { intake: 0, vitals: 0, holders: 0, reporter: 0, backtest: 0 };
let running = { intake: false, vitals: false, holders: false, reporter: false, backtest: false };

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
      await loadWeights();
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
        if (running.holders || Date.now() - last.holders < HOLDERS_MS) return;
        running.holders = true;
        last.holders = Date.now();
        void guarded("holders", holdersTick).finally(() => { running.holders = false; });
      }, 8_000);
      setInterval(() => {
        if (running.reporter || Date.now() - last.reporter < REPORT_MS) return;
        running.reporter = true;
        last.reporter = Date.now();
        void guarded("reporter", reporterTick).finally(() => { running.reporter = false; });
      }, 15_000);
      setInterval(() => {
        if (running.backtest || Date.now() - last.backtest < BACKTEST_MS) return;
        running.backtest = true;
        last.backtest = Date.now();
        void guarded("backtest", backtestTick).finally(() => { running.backtest = false; });
      }, 30_000);
      started = true;
      log.info("ward agents started (intake · vitals · holders · reporter · backtest)");
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
      holders: HOLDERS_MS,
      reporter: REPORT_MS,
      backtest: BACKTEST_MS,
    },
  };
}

export async function runFullTick(): Promise<Record<string, unknown>> {
  await ensureRuntime();
  const out: Record<string, unknown> = {};
  await guarded("intake", async () => { out.intake = await intakeTick(); });
  await guarded("vitals", async () => { out.vitals = await vitalsTick(); });
  await guarded("holders", async () => { out.holders = await holdersTick(); });
  await guarded("reporter", async () => { out.reporter = await reporterTick(); });
  return out;
}
