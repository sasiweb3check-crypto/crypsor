import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gainMatrix, gainPct, inEarlyBand, labelOf, rungOf, statusOf } from "./desk.ts";

describe("desk status", () => {
  it("archives only when the last print is under $5k", () => {
    assert.equal(statusOf(4_999, 20_000), "dead");
    assert.equal(statusOf(5_000, 20_000), "live");
  });

  it("marks running when last MC is above detected", () => {
    assert.equal(statusOf(30_000, 20_000), "running");
    assert.equal(statusOf(20_000, 20_000), "live");
    assert.equal(statusOf(15_000, 20_000), "live");
  });

  it("keeps a sub-$5k detect live until a last print is under $5k", () => {
    assert.equal(statusOf(null, 3_000), "live");
    assert.equal(statusOf(4_206, 4_206), "dead");
    assert.equal(statusOf(22_906, 4_206), "running");
  });

  it("prints gain vs the buy freeze", () => {
    assert.equal(gainPct(30_000, 20_000), 50);
    assert.equal(gainPct(10_000, 20_000), -50);
    assert.equal(gainPct(null, 20_000), null);
  });

  it("rungs from the current print vs detected, including 3×", () => {
    assert.equal(rungOf(12_900, 12_900), 1);
    assert.equal(rungOf(25_840, 12_920), 2);
    assert.equal(rungOf(38_760, 12_920), 3);
    assert.equal(rungOf(64_600, 12_920), 5);
    assert.equal(rungOf(129_200, 12_920), 10);
    assert.equal(rungOf(236_115, 12_920), 10);
    assert.equal(rungOf(258_400, 12_920), 20);
    assert.equal(rungOf(null, 12_920), 1);
    assert.equal(rungOf(22_906, 4_206), 5);
    assert.equal(rungOf(12_618, 4_206), 3);
  });

  it("labels from score and rug path, not 2× vs detected", () => {
    assert.equal(labelOf({ lastMc: 12_900, detectedMc: 12_900 }), "watch");
    assert.equal(labelOf({ lastMc: 26_000, detectedMc: 12_900 }), "watch");
    assert.equal(labelOf({ lastMc: 40_000, detectedMc: 12_900, score: 72 }), "setup");
    assert.equal(labelOf({ lastMc: 400_000, detectedMc: 400_000, score: 81 }), "hot");
    assert.equal(labelOf({ lastMc: 22_906, detectedMc: 4_206, rug: "dump" }), "dump");
    assert.equal(labelOf({ lastMc: 20_000, detectedMc: 12_900, walletBuys: 3, score: 55 }), "watch");
    assert.equal(labelOf({ lastMc: 200_000, detectedMc: 200_000 }), "watch");
    assert.equal(labelOf({ lastMc: 3_000, detectedMc: 12_900 }), "dead");
  });

  it("flags the 5k–30k early band", () => {
    assert.equal(inEarlyBand(5_000), true);
    assert.equal(inEarlyBand(12_900), true);
    assert.equal(inEarlyBand(30_000), true);
    assert.equal(inEarlyBand(4_999), false);
    assert.equal(inEarlyBand(80_000), false);
  });

  it("builds the 2×/5×/10× matrix from now vs peak", () => {
    const m = gainMatrix([
      { gain_pct: 100, ath_pct: 400 },
      { gain_pct: -20, ath_pct: 50 },
      { gain_pct: 900, ath_pct: 1100 },
      { gain_pct: null, ath_pct: null },
    ]);
    assert.equal(m.n, 4);
    assert.equal(m.now["2"].n, 2);
    assert.equal(m.peak["2"].n, 2);
    assert.equal(m.now["5"].n, 1);
    assert.equal(m.peak["5"].n, 2);
    assert.equal(m.now["10"].n, 1);
    assert.equal(m.peak["10"].n, 1);
  });
});
