import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HOT_FLOOR, hotness, isHotEnough } from "./hotness.ts";

const base = {
  mcUsd: 40_000,
  liqUsd: 25_000,
  vol1h: 50_000,
  vol5m: 8_000,
  buys1h: 40,
  sells1h: 18,
  chg1h: 12,
  chg6h: 40,
  tapeLead: "buyers" as const,
  socials: 2,
  walletBuys: 1,
  quality: 80,
  survival: 70,
  ageHours: 6,
};

describe("hotness", () => {
  it("keeps a healthy buy-led name on the desk", () => {
    const n = hotness(base);
    assert.ok(n >= HOT_FLOOR, String(n));
    assert.equal(isHotEnough(n), true);
  });

  it("hides rugs, chases, and seller tape", () => {
    assert.equal(hotness({ ...base, mcUsd: 2_000 }), 0);
    assert.ok(hotness({ ...base, chase: true }) < HOT_FLOOR);
    assert.ok(hotness({ ...base, dead: true }) < HOT_FLOOR);
    assert.ok(hotness({ ...base, tapeLead: "sellers", buys1h: 8, sells1h: 40 }) < HOT_FLOOR);
  });

  it("does not list an unread public name just because it was boosted", () => {
    const n = hotness({
      ...base,
      walletBuys: 0,
      quality: 15,
      survival: 20,
      vol1h: 500,
      vol5m: 0,
      buys1h: 1,
      sells1h: 1,
      tapeLead: "unknown",
      boosted: true,
      socials: 1,
    });
    assert.ok(n < HOT_FLOOR, String(n));
  });
});
