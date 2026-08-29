import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  alertLane, catalystOf, labelOf, pctDelta, rungOf, scoreAtPoint, scoreBreakdown, scoreBucket, scoreStepOf, screenAlert,
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

  it("steps frozen score at 40 / 60 / 80", () => {
    assert.equal(scoreStepOf(39), 0);
    assert.equal(scoreStepOf(40), 40);
    assert.equal(scoreStepOf(59), 40);
    assert.equal(scoreStepOf(60), 60);
    assert.equal(scoreStepOf(80), 80);
  });

  it("skips missing holders instead of dumping the score", () => {
    const withHolders = scoreAtPoint(pt({ mc: 12_900, detected: 12_900, holders: 400 }), null);
    const without = scoreAtPoint(pt({ mc: 12_900, detected: 12_900 }), null);
    assert.ok(without >= 20 && without < 50, `bare ${without}`);
    assert.ok(Math.abs(withHolders - without) < 25, `holders ${withHolders} bare ${without}`);
  });

  it("can call before 2× when volume, flow, and liq print hot", () => {
    const quiet = scoreAtPoint(pt({ mc: 12_900, detected: 12_900 }), null);
    const hot = scoreAtPoint(pt({
      mc: 12_900,
      detected: 12_900,
      liq: 12_000,
      vol5m: 4_000,
      buys5m: 80,
      sells5m: 20,
      priceChgM5: 9,
    }), null);
    assert.ok(hot > quiet, `hot ${hot} quiet ${quiet}`);
    assert.ok(hot >= 40, `hot should cross 40, got ${hot}`);
    assert.ok(quiet < 40, `quiet should stay under 40, got ${quiet}`);
  });

  it("cuts flow when sells dominate", () => {
    const buys = scoreAtPoint(pt({ mc: 12_900, detected: 12_900, buys5m: 40, sells5m: 8 }), null);
    const sells = scoreAtPoint(pt({ mc: 12_900, detected: 12_900, buys5m: 8, sells5m: 40 }), null);
    assert.ok(buys > sells, `buys ${buys} sells ${sells}`);
  });

  it("persists named factors on the breakdown", () => {
    const b = scoreBreakdown(pt({
      mc: 22_906,
      detected: 4_206,
      vol5m: 2_400,
      buys5m: 30,
      sells5m: 8,
      holders: 220,
      replies: 12,
    }), pt({ mc: 8_500, detected: 4_206, holders: 180 }));
    assert.ok(b.score >= 70, `got ${b.score}`);
    assert.ok(b.factors.multiple != null);
    assert.ok(b.factors.volume != null);
    assert.ok(b.factors.flow != null);
    assert.ok(b.factors.holders != null);
    assert.ok(b.catalyst.includes("5.4×"));
  });
});
