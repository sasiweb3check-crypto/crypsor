import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  emptyTape, judge, nextPhase, prognosis, resetWeights, type Reading, type TapeWindow,
} from "./ward.ts";

function tape(buys: number, sells: number, extra: Partial<TapeWindow> = {}): TapeWindow {
  return { buys, sells, volUsd: extra.volUsd ?? 1_000, changePct: extra.changePct ?? 0 };
}

function reading(over: Partial<Reading> = {}): Reading {
  return {
    mcUsd: 25_000,
    liqUsd: 12_000,
    priceUsd: 0.001,
    holders: 80,
    prevHolders: 70,
    prevLiq: 11_000,
    top10Pct: 28,
    bundlerHoldPct: 10,
    sniperHoldPct: 8,
    botHoldPct: 12,
    smartCount: 2,
    kolCount: 1,
    whaleHoldPct: 5,
    m5: tape(20, 8),
    h1: tape(80, 30),
    h6: tape(200, 90, { volUsd: 8_000, changePct: 12 }),
    admissionMc: 20_000,
    walletBuys: 2,
    graduated: true,
    scansTotal: 4,
    ...over,
  };
}

describe("ward judge", () => {
  beforeEach(() => resetWeights());

  it("does not invent a pass from unread tape", () => {
    const v = judge(reading({
      m5: emptyTape(),
      h1: emptyTape(),
      h6: emptyTape(),
      walletBuys: 1,
      scansTotal: 0,
    }));
    assert.equal(v.tapeLead, "unknown");
    assert.ok(v.unknowns.includes("tape_unread"));
    assert.equal(v.tradeOk, false);
  });

  it("fails when sellers led the live hour", () => {
    const v = judge(reading({ h1: tape(10, 40), m5: tape(4, 20) }));
    assert.equal(v.tapeLead, "sellers");
    assert.ok(v.fails.includes("sell_led_tape"));
    assert.equal(v.tradeOk, false);
  });

  it("fails two-sided 1h — nobody leading (omo)", () => {
    const v = judge(reading({ h1: tape(50, 50), m5: tape(12, 10) }));
    assert.equal(v.tapeLead, "two_sided");
    assert.ok(v.fails.includes("tape_two_sided"));
  });

  it("refuses chase on a 6h rocket", () => {
    const v = judge(reading({ h6: tape(80, 20, { changePct: 310, volUsd: 40_000 }) }));
    assert.equal(v.chase, true);
    assert.ok(v.fails.includes("chase"));
    assert.equal(v.tradeOk, false);
  });

  it("refuses chase when already 5× since admit", () => {
    const v = judge(reading({ mcUsd: 120_000, admissionMc: 20_000 }));
    assert.equal(v.chase, true);
    assert.equal(v.tradeOk, false);
  });

  it("calls LP gone death, not a drawdown", () => {
    const dead = judge(reading({ liqUsd: 80, mcUsd: 900 }));
    assert.equal(dead.dead, true);
    assert.ok(dead.fails.includes("liq_dead"));
    const drawdown = judge(reading({ mcUsd: 12_000, admissionMc: 25_000, liqUsd: 10_000 }));
    assert.equal(drawdown.dead, false);
    assert.equal(drawdown.chase, false);
  });

  it("judges bots by hold share, not counts", () => {
    const v = judge(reading({ botHoldPct: 70, bundlerHoldPct: 60, top10Pct: 62, smartCount: 40 }));
    assert.ok(v.fails.includes("structure_bad"));
  });

  it("opens TRADE only with evidence, holds, and enough scans", () => {
    const early = judge(reading({ scansTotal: 1, walletBuys: 1 }));
    assert.equal(early.tradeOk, false);
    const ok = judge(reading());
    assert.equal(ok.tradeOk, true);
    assert.ok(ok.score >= 68);
    assert.ok(ok.holds.length >= 2);
  });
});

describe("ward phases", () => {
  beforeEach(() => resetWeights());

  it("moves sell-led patients to ICU (about to die)", () => {
    const v = judge(reading({ h1: tape(8, 40), m5: tape(3, 18) }));
    assert.equal(nextPhase("ward", v, 3), "icu");
    assert.equal(prognosis("icu", v.score, v.fails).id, "critical");
  });

  it("marks dust / holder collapse deceased", () => {
    const v = judge(reading({ mcUsd: 400, holders: 4, liqUsd: 50 }));
    assert.equal(nextPhase("ward", v, 3), "deceased");
    assert.equal(prognosis("deceased", v.score, v.fails).id, "dead");
  });

  it("revives a deceased patient when buyers return", () => {
    const v = judge(reading({ mcUsd: 18_000, liqUsd: 9_000, holders: 60 }));
    assert.equal(nextPhase("deceased", v, 5), "revived");
    assert.equal(prognosis("revived", v.score, v.fails).id, "revived");
  });

  it("recovers ICU when buyers lead and score holds", () => {
    const v = judge(reading());
    assert.equal(nextPhase("icu", v, 4), "recovery");
    assert.equal(prognosis("recovery", v.score, v.fails).id, "recovering");
  });
});
