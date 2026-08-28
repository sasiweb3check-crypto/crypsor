import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { athPct, gainPct, laneOf, rollDays } from "./stats.ts";

describe("pass stats", () => {
  it("prints gain and ATH % off the pass market cap", () => {
    assert.equal(gainPct(30_000, 20_000), 50);
    assert.equal(athPct(40_000, 20_000), 100);
    assert.equal(gainPct(10_000, 20_000), -50);
    assert.equal(gainPct(null, 20_000), null);
    assert.equal(athPct(40_000, 0), null);
  });

  it("lanes live / archived / dead", () => {
    assert.equal(laneOf("open"), "live");
    assert.equal(laneOf("trim"), "live");
    assert.equal(laneOf("exit"), "archived");
    assert.equal(laneOf("dead"), "dead");
    assert.equal(laneOf("open", "deceased"), "dead");
  });

  it("rolls other days without mixing lanes", () => {
    const days = rollDays([
      { day: "2026-08-28", status: "open", gain_pct: 20, ath_pct: 80 },
      { day: "2026-08-28", status: "dead", gain_pct: -40, ath_pct: 10 },
      { day: "2026-08-27", status: "exit", gain_pct: 120, ath_pct: 210 },
    ]);
    assert.equal(days[0].day, "2026-08-28");
    assert.equal(days[0].passed, 2);
    assert.equal(days[0].live, 1);
    assert.equal(days[0].dead, 1);
    assert.equal(days[0].hit2x, 0);
    assert.equal(days[1].day, "2026-08-27");
    assert.equal(days[1].hit2x, 1);
    assert.equal(days[1].bestAthPct, 210);
    assert.equal(days[1].archived, 1);
  });
});
