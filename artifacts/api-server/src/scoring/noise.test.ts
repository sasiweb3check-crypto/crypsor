import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isNoiseMint, isNoiseSymbol, isNoiseToken } from "./noise.ts";

describe("noise filter", () => {
  it("drops wSOL, USDC, jitoSOL, wrapped BTC", () => {
    assert.equal(isNoiseMint("So11111111111111111111111111111111111111112"), true);
    assert.equal(isNoiseMint("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"), true);
    assert.equal(isNoiseMint("cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij"), true);
    assert.equal(isNoiseSymbol("jitoSOL"), true);
    assert.equal(isNoiseSymbol("$BTC"), true);
    assert.equal(isNoiseToken("abc", "WBTC"), true);
  });

  it("lets a memecoin through", () => {
    assert.equal(isNoiseMint("7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"), false);
    assert.equal(isNoiseSymbol("PEPE"), false);
    assert.equal(isNoiseToken("7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", "PEPE"), false);
  });
});
