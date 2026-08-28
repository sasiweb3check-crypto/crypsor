import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { judgeSeries } from "./survival.ts";

describe("snapshot survival", () => {
  it("rewards continued live climbs and calls momentum up", () => {
    const j = judgeSeries([
      { kind: "pulse", mc_slope: 0.1, incomplete: false },
      { kind: "confirm", mc_slope: 0.12, incomplete: false },
      { kind: "hour", mc_slope: 0.08, incomplete: false },
    ]);
    assert.ok(j.survival >= 70);
    assert.equal(j.momentum, "up");
    assert.equal(j.dumps, 0);
  });

  it("punishes dumps and incomplete prints", () => {
    const j = judgeSeries([
      { kind: "pulse", mc_slope: -0.22, liq_slope: -0.3, holder_slope: -0.1, incomplete: false },
      { kind: "confirm", incomplete: true },
      { kind: "hour", mc_slope: -0.18, incomplete: false },
    ]);
    assert.ok(j.survival < 45);
    assert.equal(j.momentum, "down");
    assert.ok(j.dumps >= 1);
  });

  it("stays unread with no series", () => {
    const j = judgeSeries([]);
    assert.equal(j.momentum, "unread");
    assert.equal(j.survival, 50);
  });
});
