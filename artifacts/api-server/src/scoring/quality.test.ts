import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  capBand, mergeSources, relDisagree, slope, snapshotCadenceMs, snapshotSuggestions,
  type SnapshotInput, type SourceRead,
} from "./quality.ts";

function read(over: Partial<SourceRead> & { source: SourceRead["source"] }): SourceRead {
  return {
    ok: true,
    mcUsd: 50_000,
    liqUsd: 12_000,
    holders: 200,
    top10Pct: 28,
    ...over,
  };
}

function snap(over: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    band: "low",
    phase: "ward",
    score: 72,
    prevScore: 70,
    mc: 40_000,
    prevMc: 35_000,
    liq: 10_000,
    prevLiq: 9_500,
    holders: 180,
    prevHolders: 170,
    top10Pct: 30,
    tapeLead: "buyers",
    chase: false,
    tradeOk: false,
    dead: false,
    quality: 80,
    flags: [],
    walletBuys: 2,
    unknowns: [],
    ...over,
  };
}

describe("cap bands", () => {
  it("splits low / mid / mega", () => {
    assert.equal(capBand(20_000), "low");
    assert.equal(capBand(120_000), "mid");
    assert.equal(capBand(900_000), "mega");
    assert.equal(capBand(null), null);
  });

  it("pulse is faster than confirm; ICU is faster than a quiet mega", () => {
    assert.ok(snapshotCadenceMs("low", "ward", "pulse") < snapshotCadenceMs("low", "ward", "confirm"));
    assert.ok(snapshotCadenceMs("mid", "icu", "confirm") < snapshotCadenceMs("mega", "ward", "confirm"));
    assert.equal(snapshotCadenceMs("low", "ward", "pulse"), 2 * 60_000);
    assert.equal(snapshotCadenceMs("low", "ward", "confirm"), 5 * 60_000);
  });
});

describe("mergeSources", () => {
  it("prefers pump MC while bonding, dex MC once graduated", () => {
    const bonding = mergeSources([
      read({ source: "dex", mcUsd: 80_000 }),
      read({ source: "pump", mcUsd: 40_000 }),
    ], false);
    assert.equal(bonding.mcUsd, 40_000);
    assert.equal(bonding.used.mc, "pump");

    const grad = mergeSources([
      read({ source: "dex", mcUsd: 80_000 }),
      read({ source: "pump", mcUsd: 40_000 }),
    ], true);
    assert.equal(grad.mcUsd, 80_000);
    assert.equal(grad.used.mc, "dex");
  });

  it("flags MC disagreement and does not invent holders", () => {
    const m = mergeSources([
      read({ source: "dex", mcUsd: 100_000, liqUsd: 20_000, holders: null }),
      read({ source: "pump", mcUsd: 40_000, liqUsd: 18_000, holders: null }),
      { source: "gmgn", ok: false, mcUsd: null, liqUsd: null, holders: null, top10Pct: null },
    ], true);
    assert.ok(m.flags.includes("mc_disagree"));
    assert.ok(m.flags.includes("missing_holders"));
    assert.ok(m.quality < 80);
    assert.equal(m.holders, null);
  });

  it("fills liq from GMGN when Dex is blank", () => {
    const m = mergeSources([
      read({ source: "dex", ok: true, mcUsd: 50_000, liqUsd: null }),
      read({ source: "pump", liqUsd: 8_000 }),
      read({ source: "gmgn", mcUsd: null, liqUsd: 11_000, holders: 90 }),
    ], true);
    assert.equal(m.liqUsd, 11_000);
    assert.equal(m.used.liq, "gmgn");
    assert.equal(m.holders, 90);
  });
});

describe("relDisagree / slope", () => {
  it("needs both sides to disagree", () => {
    assert.equal(relDisagree(100, 80), false);
    assert.equal(relDisagree(100, 70), true);
    assert.equal(relDisagree(100, null), false);
  });

  it("slope is a fraction vs previous", () => {
    assert.equal(slope(120, 100), 0.2);
    assert.equal(slope(80, 100), -0.2);
    assert.equal(slope(50, null), null);
  });
});

describe("snapshotSuggestions", () => {
  it("opens TRADE and refuses chase", () => {
    const trade = snapshotSuggestions(snap({ tradeOk: true }));
    assert.ok(trade.some((s) => s.id === "trade" && s.severity === "act"));
    const chase = snapshotSuggestions(snap({ chase: true, tradeOk: false }));
    assert.ok(chase.some((s) => s.id === "chase"));
  });

  it("calls holder exodus and liq drain from snapshot slopes", () => {
    const v = snapshotSuggestions(snap({
      holders: 100, prevHolders: 140, liq: 4_000, prevLiq: 10_000, tradeOk: false,
    }));
    assert.ok(v.some((s) => s.id === "holder_exodus"));
    assert.ok(v.some((s) => s.id === "liq_drain"));
  });

  it("warns when sources are thin or disagree", () => {
    const v = snapshotSuggestions(snap({
      quality: 28, flags: ["gmgn_down", "missing_holders", "mc_disagree"], unknowns: ["holders_unread"],
    }));
    assert.ok(v.some((s) => s.id === "quality_thin"));
    assert.ok(v.some((s) => s.id === "disagree"));
  });

  it("tags low-cap heat when MC climbs on a buy tape", () => {
    const v = snapshotSuggestions(snap({ band: "low", mc: 48_000, prevMc: 30_000, tapeLead: "buyers" }));
    assert.ok(v.some((s) => s.id === "mc_climb" && s.title.includes("Low-cap")));
  });
});
