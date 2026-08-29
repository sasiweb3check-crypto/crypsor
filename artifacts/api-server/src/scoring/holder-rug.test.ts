import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  holderBookFromPercents, holderBookFromRpc, holderRugOf, holdersRugLine, uiAmountOf,
} from "./holder-rug.ts";

/** GMGN Holders screenshot: Raydium 16.48%, top10 excl 59.90%, top10 76.38%, top20 80.77%. */
const GMGN = {
  top10Pct: 76.38,
  top10ExclLp: 59.90,
  top20Pct: 80.77,
  clusterN: 8,
};

/** Clustered wallets at 4.4–7.6% after a 16.48% LP — the split-supply pattern. */
const CLUSTERED = [
  16.48,
  7.6, 7.4, 6.9, 6.5, 6.2, 5.8, 5.4, 5.0, 4.7, 4.4,
  1.2, 0.9, 0.7, 0.5,
];

describe("holders rug possible", () => {
  it("flags the GMGN screenshot percents on the first print", () => {
    const v = holderRugOf(GMGN);
    assert.equal(v.holdersRug, true);
    assert.match(v.reason ?? "", /top10 excl LP 59\.9%/);
    assert.equal(
      holdersRugLine({ holdersRug: true, top10ExclLp: 59.90 }),
      "holders rug possible · top10 excl LP 59.9%",
    );
  });

  it("flags clustered wallets after dropping a ≥10% LP", () => {
    const book = holderBookFromPercents(CLUSTERED, 293);
    assert.equal(book.measured, true);
    assert.ok((book.lpPct ?? 0) >= 16);
    assert.ok((book.top10ExclLp ?? 0) >= 50, `excl ${book.top10ExclLp}`);
    assert.ok((book.clusterN ?? 0) >= 4, `cluster ${book.clusterN}`);
    assert.equal(book.holdersRug, true);
    assert.equal(book.holders, 293);
  });

  it("does not treat mint/freeze revoked or LP burned as a pass", () => {
    const v = holderRugOf(GMGN);
    assert.equal(v.holdersRug, true);
    assert.equal("mintRevoked" in v, false);
    assert.equal("freezeRevoked" in v, false);
    assert.equal("lpBurned" in v, false);
  });

  it("cautions at 40–50% top10 excl LP without calling it a rug", () => {
    const v = holderRugOf({ top10Pct: 52, top10ExclLp: 44, top20Pct: 58, clusterN: 2 });
    assert.equal(v.holdersRug, false);
    assert.equal(v.holdersCaution, true);
  });

  it("does not flag a distributed book", () => {
    const pcts = [8.2, 3.1, 2.4, 2.1, 1.8, 1.5, 1.2, 1.1, 0.9, 0.8, 0.7, 0.6];
    const book = holderBookFromPercents(pcts, 800);
    assert.equal(book.holdersRug, false);
    assert.equal(book.holdersCaution, false);
    assert.ok((book.top10ExclLp ?? 0) < 40);
  });

  it("skips missing RPC instead of inventing 0% as safe", () => {
    const empty = holderBookFromPercents([], 293);
    assert.equal(empty.measured, false);
    assert.equal(empty.holdersRug, false);
    assert.equal(empty.top10Pct, null);
    assert.equal(empty.top10ExclLp, null);
    const skipped = holderBookFromRpc(null, null, 293);
    assert.equal(skipped.measured, false);
    assert.equal(skipped.holders, 293);
  });

  it("reads uiAmount and raw amount/decimals the same way", () => {
    assert.equal(uiAmountOf({ uiAmount: 164_800_000 }), 164_800_000);
    assert.equal(uiAmountOf({ amount: "164800000000000", decimals: 6 }), 164_800_000);
    assert.equal(uiAmountOf({}), null);
  });

  it("builds percents from largest-accounts + supply RPC payloads", () => {
    const supply = 1_000_000_000;
    const largest = {
      value: CLUSTERED.map((pct, i) => ({
        address: `acct${i}`,
        uiAmount: (pct / 100) * supply,
        decimals: 6,
      })),
    };
    const book = holderBookFromRpc(largest, { value: { uiAmount: supply, decimals: 6 } }, 293);
    assert.equal(book.measured, true);
    assert.equal(book.holdersRug, true);
    assert.ok((book.top10ExclLp ?? 0) >= 50);
  });
});
