import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gainMatrix, gainPct, inEarlyBand, labelOf, rungOf, statusOf } from "./desk.ts";

describe("desk status", () => {
  it("archives below $5k", () => {
    assert.equal(statusOf(4_999, 20_000), "dead");
    assert.equal(statusOf(5_000, 20_000), "live");
  });

  it("marks running when last MC is above detected", () => {
    assert.equal(statusOf(30_000, 20_000), "running");
    assert.equal(statusOf(20_000, 20_000), "live");
    assert.equal(statusOf(15_000, 20_000), "live");
  });

  it("archives when only detected MC is under $5k", () => {
    assert.equal(statusOf(null, 3_000), "dead");
    assert.equal(statusOf(null, 20_000), "live");
  });

  it("prints gain vs the buy freeze", () => {
    assert.equal(gainPct(30_000, 20_000), 50);
    assert.equal(gainPct(10_000, 20_000), -50);
    assert.equal(gainPct(null, 20_000), null);
  });

  it("rungs from the current print vs detected, not peak", () => {
    assert.equal(rungOf(12_900, 12_900), 1);
    assert.equal(rungOf(25_840, 12_920), 2);
    assert.equal(rungOf(64_600, 12_920), 5);
    assert.equal(rungOf(129_200, 12_920), 10);
    assert.equal(rungOf(236_115, 12_920), 10);
    assert.equal(rungOf(258_400, 12_920), 20);
    assert.equal(rungOf(null, 12_920), 1);
  });

  it("labels surviving names from last print vs detected", () => {
    assert.equal(labelOf({ lastMc: 12_900, detectedMc: 12_900, walletBuys: 1 }), "watch");
    assert.equal(labelOf({ lastMc: 12_000, detectedMc: 12_900, walletBuys: 2 }), "heat");
    assert.equal(labelOf({ lastMc: 26_000, detectedMc: 12_900, walletBuys: 1 }), "call");
    assert.equal(labelOf({ lastMc: 70_000, detectedMc: 12_900, walletBuys: 1 }), "runner");
    assert.equal(labelOf({ lastMc: 20_000, detectedMc: 12_900, walletBuys: 3 }), "runner");
    assert.equal(labelOf({ lastMc: 200_000, detectedMc: 200_000, walletBuys: 1 }), "late");
    assert.equal(labelOf({ lastMc: 3_000, detectedMc: 12_900, walletBuys: 2 }), "dead");
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
