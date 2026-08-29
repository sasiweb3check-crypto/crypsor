import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  boostsOf, buys5mOf, liqOf, sells5mOf, vol5mOf, volH1Of, type DexPair,
} from "./pair-stats.ts";

const pair: DexPair = {
  chainId: "solana",
  marketCap: 22_000,
  liquidity: { usd: 8_400 },
  volume: { m5: 285.1, h1: 6_131 },
  txns: { m5: { buys: 7, sells: 2 }, h1: { buys: 124, sells: 51 } },
  boosts: { active: 2 },
};

describe("dex pair helpers", () => {
  it("reads liq, volume, and tape counts without inventing zeros", () => {
    assert.equal(liqOf(pair), 8_400);
    assert.equal(vol5mOf(pair), 285.1);
    assert.equal(volH1Of(pair), 6_131);
    assert.equal(buys5mOf(pair), 7);
    assert.equal(sells5mOf(pair), 2);
    assert.equal(boostsOf(pair), 2);
  });

  it("returns null when a field is missing", () => {
    assert.equal(liqOf({}), null);
    assert.equal(vol5mOf({}), null);
    assert.equal(buys5mOf({}), null);
    assert.equal(boostsOf({}), null);
  });
});
