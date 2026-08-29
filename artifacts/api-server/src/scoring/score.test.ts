import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  alertLane, catalystOf, labelOf, pctDelta, rungOf, scoreAtPoint, scoreBucket, screenAlert,
  type ScorePoint,
} from "./desk.ts";

function pt(partial: Partial<ScorePoint> & { mc: number; detected: number }): ScorePoint {
  const survived = partial.survived ?? true;
  const label = partial.label ?? labelOf({ lastMc: partial.mc, detectedMc: partial.detected });
  return { liq: 8_000, ...partial, survived, label };
}

describe("snapshot score", () => {
  it("sends confidence calls to the screen regardless of detected band", () => {
    assert.equal(alertLane(4_206), "call");
    assert.equal(alertLane(12_900), "call");
    assert.equal(alertLane(90_000), "call");
    assert.equal(screenAlert("call"), true);
    assert.equal(screenAlert("high"), false);
  });

  it("freezes dead prints at 0", () => {
    assert.equal(scoreAtPoint(pt({ mc: 3_000, detected: 12_900, survived: false, label: "dead" }), null), 0);
  });

  it("scores a first print near detected in the watch/mid band, not 100", () => {
    const s = scoreAtPoint(pt({ mc: 12_900, detected: 12_900 }), null);
    assert.ok(s >= 20 && s < 50, `got ${s}`);
  });

  it("raises score when the next snapshot is up vs memory", () => {
    const prev = pt({ mc: 12_900, detected: 12_900, score: 40 });
    const now = pt({ mc: 16_000, detected: 12_900 });
    const s = scoreAtPoint(now, prev);
    assert.ok(s > scoreAtPoint(now, null), `with memory ${s}`);
  });

  it("cuts score on a dump vs the previous snapshot", () => {
    const prev = pt({ mc: 20_000, detected: 12_900, score: 62 });
    const now = pt({ mc: 11_000, detected: 12_900 });
    const up = scoreAtPoint(pt({ mc: 22_000, detected: 12_900 }), prev);
    const down = scoreAtPoint(now, prev);
    assert.ok(down < up, `down ${down} up ${up}`);
  });

  it("does not raise score for extra tracked wallets", () => {
    const prev = pt({ mc: 12_900, detected: 12_900, score: 40 });
    const one = scoreAtPoint(pt({ mc: 12_900, detected: 12_900, wallets: 1 }), prev);
    const two = scoreAtPoint(pt({ mc: 12_900, detected: 12_900, wallets: 2 }), prev);
    assert.equal(two, one);
  });

  it("calls MONA-style 4k→22k as 5× with a freeze catalyst", () => {
    assert.equal(rungOf(22_906, 4_206), 5);
    const text = catalystOf({ lastMc: 22_906, detectedMc: 4_206, vol5m: 94 });
    assert.match(text, /5\.4×/);
    assert.match(text, /\$4\.2K/);
    assert.match(text, /vol/i);
    const s = scoreAtPoint(pt({ mc: 22_906, detected: 4_206 }), pt({ mc: 8_500, detected: 4_206 }));
    assert.ok(s >= 70, `got ${s}`);
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
