import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  alertLane, labelOf, pctDelta, scoreAtPoint, scoreBucket, screenAlert, type ScorePoint,
} from "./desk.ts";

function pt(partial: Partial<ScorePoint> & { mc: number; detected: number }): ScorePoint {
  const wallets = partial.wallets ?? 1;
  const survived = partial.survived ?? true;
  const label = partial.label ?? labelOf({ lastMc: partial.mc, detectedMc: partial.detected, walletBuys: wallets });
  return { liq: 8_000, ...partial, wallets, survived, label };
}

describe("snapshot score", () => {
  it("routes screen alerts only in the $5k–$30k band", () => {
    assert.equal(alertLane(12_900), "early");
    assert.equal(alertLane(30_000), "early");
    assert.equal(alertLane(30_001), "high");
    assert.equal(alertLane(82_000), "high");
    assert.equal(alertLane(null), "high");
    assert.equal(screenAlert("early"), true);
    assert.equal(screenAlert("high"), false);
  });

  it("freezes dead prints at 0", () => {
    assert.equal(scoreAtPoint(pt({ mc: 3_000, detected: 12_900, survived: false, label: "dead" }), null), 0);
  });

  it("scores an early first print in the watch/mid band, not 100", () => {
    const s = scoreAtPoint(pt({ mc: 12_900, detected: 12_900, wallets: 1 }), null);
    assert.ok(s >= 30 && s < 50, `got ${s}`);
  });

  it("raises score when the next snapshot is up vs memory", () => {
    const prev = pt({ mc: 12_900, detected: 12_900, wallets: 1, score: 40 });
    const now = pt({ mc: 16_000, detected: 12_900, wallets: 1 });
    const s = scoreAtPoint(now, prev);
    assert.ok(s > scoreAtPoint(now, null), `with memory ${s}`);
  });

  it("cuts score on a dump vs the previous snapshot", () => {
    const prev = pt({ mc: 20_000, detected: 12_900, wallets: 1, score: 62 });
    const now = pt({ mc: 11_000, detected: 12_900, wallets: 1 });
    const up = scoreAtPoint(pt({ mc: 22_000, detected: 12_900, wallets: 1 }), prev);
    const down = scoreAtPoint(now, prev);
    assert.ok(down < up, `down ${down} up ${up}`);
  });

  it("adds wallet confirmation vs previous memory", () => {
    const prev = pt({ mc: 12_900, detected: 12_900, wallets: 1, score: 40 });
    const one = scoreAtPoint(pt({ mc: 12_900, detected: 12_900, wallets: 1 }), prev);
    const two = scoreAtPoint(pt({ mc: 12_900, detected: 12_900, wallets: 2 }), prev);
    assert.ok(two > one, `two ${two} one ${one}`);
  });

  it("keeps high-MC names scorable but not in the early lane", () => {
    const s = scoreAtPoint(pt({ mc: 90_000, detected: 90_000, wallets: 1, label: "late" }), null);
    assert.ok(s > 0 && s < 70, `got ${s}`);
    assert.equal(alertLane(90_000), "high");
  });

  it("buckets scores for alert calibration", () => {
    assert.equal(scoreBucket(0), "0-19");
    assert.equal(scoreBucket(39), "20-39");
    assert.equal(scoreBucket(40), "40-59");
    assert.equal(scoreBucket(80), "80-100");
    assert.equal(scoreBucket(null), null);
  });

  it("prints a percent delta between two snapshot points", () => {
    assert.equal(pctDelta(15_000, 10_000), 50);
    assert.equal(pctDelta(8_000, 10_000), -20);
    assert.equal(pctDelta(10_000, 0), null);
  });
});
