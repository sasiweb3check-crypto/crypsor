import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gainPct, statusOf } from "./desk.ts";

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
});
