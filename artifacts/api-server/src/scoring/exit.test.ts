import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXIT_LIMITS, evaluateExitRules, multiple, planExit,
  type ExitInput, type ExitInputs,
} from "./exit.ts";

const base: ExitInputs = {
  symbol: "$TEST",
  mint: "TestMint111111111111111111111111111111111111",
  unrealizedPct: 5,
  peakPct: 5,
  trimsTaken: 0,
  holdDays: 1,
  positionUsd: 1_000,
  liquidityUsd: 120_000,
  volumeUsd: 90_000,
  buys: 400,
  sells: 300,
  chg6h: 4,
};

function input(over: Partial<ExitInput> = {}): ExitInput {
  return {
    entryMc: 20_000,
    lastMc: 22_000,
    peakMc: 22_000,
    phase: "ward",
    tapeLead: "buyers",
    dead: false,
    liqUsd: 80_000,
    liqSlope: 0.02,
    holderSlope: 0.01,
    chg6h: 4,
    vol6h: 90_000,
    buys: 400,
    sells: 300,
    holdDays: 1,
    trimsTaken: 0,
    ...over,
  };
}

describe("evaluateExitRules (omo)", () => {
  it("holds when nothing fires", () => {
    const decision = evaluateExitRules(base);
    assert.equal(decision.fraction, 0);
    assert.deepEqual(decision.fired, []);
  });

  it("closes the whole position on the hard stop", () => {
    const decision = evaluateExitRules({ ...base, unrealizedPct: EXIT_LIMITS.stopLossPct - 1 });
    assert.equal(decision.fraction, 1);
    assert.ok(decision.fired.includes("exit_stop_loss"));
  });

  it("only arms the trailing stop after a real run", () => {
    const early = evaluateExitRules({ ...base, peakPct: 40, unrealizedPct: -5 });
    assert.ok(!early.fired.includes("exit_trailing_stop"));
    const armed = evaluateExitRules({ ...base, peakPct: 120, unrealizedPct: 70 });
    assert.equal(armed.fraction, 1);
    assert.ok(armed.fired.includes("exit_trailing_stop"));
  });

  it("exits on a liquidity break even while in profit", () => {
    const decision = evaluateExitRules({ ...base, unrealizedPct: 50, liquidityUsd: 4_000 });
    assert.equal(decision.fraction, 1);
    assert.ok(decision.fired.includes("exit_liquidity_break"));
  });

  it("exits when price and flow both break", () => {
    const decision = evaluateExitRules({ ...base, chg6h: -40, buys: 100, sells: 300 });
    assert.equal(decision.fraction, 1);
    assert.ok(decision.fired.includes("exit_thesis_invalidated"));
  });

  it("takes profit in tranches and does not retake a tranche", () => {
    const first = evaluateExitRules({ ...base, unrealizedPct: 150 });
    assert.equal(first.tranche, 0);
    assert.ok(Math.abs(first.fraction - 0.33) < 0.001);
    const again = evaluateExitRules({ ...base, unrealizedPct: 150, trimsTaken: 1 });
    assert.equal(again.fraction, 0);
  });

  it("prefers a full exit over a trim when risk is breaking", () => {
    const decision = evaluateExitRules({ ...base, unrealizedPct: 150, peakPct: 400 });
    assert.equal(decision.fraction, 1);
    assert.equal(decision.tranche, null);
  });

  it("closes a thesis that neither worked nor broke", () => {
    const decision = evaluateExitRules({
      ...base,
      holdDays: EXIT_LIMITS.staleDays + 1,
      unrealizedPct: 2,
      volumeUsd: 900,
    });
    assert.equal(decision.fraction, 1);
    assert.ok(decision.fired.includes("exit_stale_thesis"));
  });
});

describe("planExit adapter", () => {
  it("locks multiples off entry MC", () => {
    assert.equal(multiple(40_000, 20_000), 2);
    assert.equal(multiple(null, 20_000), null);
  });

  it("flattens a dead book", () => {
    const p = planExit(input({ dead: true, lastMc: 8_000 }));
    assert.equal(p.action, "exit");
    assert.equal(p.takePct, 100);
  });

  it("cuts on the hard stop vs lock", () => {
    const p = planExit(input({ lastMc: 12_000, peakMc: 14_000 }));
    assert.equal(p.action, "exit");
    assert.ok(p.fired.includes("exit_stop_loss"));
  });

  it("lets a runner hold before the first take-profit tranche", () => {
    const p = planExit(input({ lastMc: 26_000, peakMc: 26_000, liqUsd: 80_000 }));
    assert.equal(p.action, "hold");
    assert.equal(p.takePct, 0);
  });

  it("trims the first take-profit tranche at +100%", () => {
    const p = planExit(input({ lastMc: 48_000, peakMc: 50_000, liqUsd: 80_000 }));
    assert.equal(p.action, "trim");
    assert.equal(p.takePct, 33);
  });
});
