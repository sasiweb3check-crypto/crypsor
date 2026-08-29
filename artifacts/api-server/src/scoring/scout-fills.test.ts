import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bookWallet, classify, dedupeFills, fillsFromHeliusTx, filterScoutWallets,
  interpolateMc, mergeFillGaps, pumpMcFromReserves, rankWallets, type TokenFill,
} from "./scout-fills.ts";

function fill(partial: Partial<TokenFill> & Pick<TokenFill, "wallet" | "side" | "tokenAmt" | "usd" | "at">): TokenFill {
  return { sig: `s${partial.at}`, mc: null, src: "test", ...partial };
}

describe("scout fills", () => {
  it("closes a round-trip and reports ROI, winrate, and sold-all", () => {
    const w = "Trader1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const book = bookWallet(w, [
      fill({ wallet: w, side: "buy", tokenAmt: 100, usd: 50, at: 1_000, mc: 12_000 }),
      fill({ wallet: w, side: "sell", tokenAmt: 100, usd: 80, at: 10_000, mc: 20_000 }),
    ]);
    assert.equal(book.status, "sold_all");
    assert.equal(book.closedCycles, 1);
    assert.equal(book.investedUsd, 50);
    assert.equal(book.proceedsUsd, 80);
    assert.equal(book.profitUsd, 30);
    assert.equal(book.overallRoi, 0.6);
    assert.equal(book.realizedRoi, 0.6);
    assert.equal(book.winrate, 1);
    assert.equal(book.avgBuy, 0.5);
    assert.equal(book.avgSell, 0.8);
    assert.equal(book.minBuyMc, 12_000);
    assert.equal(book.avgHoldMs, 9_000);
  });

  it("detects a second entry after a full exit", () => {
    const w = "Trader2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const book = bookWallet(w, [
      fill({ wallet: w, side: "buy", tokenAmt: 10, usd: 10, at: 1 }),
      fill({ wallet: w, side: "sell", tokenAmt: 10, usd: 20, at: 2 }),
      fill({ wallet: w, side: "buy", tokenAmt: 10, usd: 15, at: 3 }),
      fill({ wallet: w, side: "sell", tokenAmt: 10, usd: 12, at: 4 }),
    ]);
    assert.equal(book.closedCycles, 2);
    assert.equal(book.winrate, 0.5);
    assert.ok(Math.abs(book.profitUsd - 7) < 1e-9);
  });

  it("marks partial vs hold from remaining inventory", () => {
    const w = "Holderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const hold = bookWallet(w, [
      fill({ wallet: w, side: "buy", tokenAmt: 100, usd: 40, at: 1 }),
    ], { balance: 100, priceUsd: 1 });
    assert.equal(hold.status, "hold");
    assert.equal(hold.profitUsd, 60);
    const part = bookWallet(w, [
      fill({ wallet: w, side: "buy", tokenAmt: 100, usd: 40, at: 1 }),
      fill({ wallet: w, side: "sell", tokenAmt: 40, usd: 30, at: 2 }),
    ], { balance: 60, priceUsd: 0.5 });
    assert.equal(part.status, "partial");
  });

  it("filters MC band without changing stored ROI", () => {
    const cheap = bookWallet("A", [fill({ wallet: "A", side: "buy", tokenAmt: 1, usd: 1, at: 1, mc: 8_000 })]);
    const late = bookWallet("B", [fill({ wallet: "B", side: "buy", tokenAmt: 1, usd: 1, at: 1, mc: 80_000 })]);
    const unknown = bookWallet("C", [fill({ wallet: "C", side: "buy", tokenAmt: 1, usd: 1, at: 1 })]);
    const rows = filterScoutWallets([cheap, late, unknown], { maxMc: 50_000 });
    assert.deepEqual(rows.map((r) => r.wallet), ["A"]);
    assert.equal(cheap.overallRoi, bookWallet("A", [fill({ wallet: "A", side: "buy", tokenAmt: 1, usd: 1, at: 1, mc: 8_000 })]).overallRoi);
  });

  it("ranks by profit then ROI", () => {
    const a = bookWallet("A", [
      fill({ wallet: "A", side: "buy", tokenAmt: 1, usd: 10, at: 1 }),
      fill({ wallet: "A", side: "sell", tokenAmt: 1, usd: 40, at: 2 }),
    ]);
    const b = bookWallet("B", [
      fill({ wallet: "B", side: "buy", tokenAmt: 1, usd: 100, at: 1 }),
      fill({ wallet: "B", side: "sell", tokenAmt: 1, usd: 110, at: 2 }),
    ]);
    assert.equal(rankWallets([b, a])[0].wallet, "A");
  });

  it("reads a pool swap as a buy when the pool is skipped", () => {
    const user = "Userxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const pool = "Poolxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const mint = "Mintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const fills = fillsFromHeliusTx({
      signature: "sig1",
      timestamp: 1_700_000_000,
      feePayer: user,
      nativeTransfers: [{ fromUserAccount: user, toUserAccount: pool, amount: 1e9 }],
      tokenTransfers: [{
        mint,
        fromUserAccount: pool,
        toUserAccount: user,
        tokenAmount: 50,
      }],
    }, mint, { skip: new Set([pool]), solUsd: 150 });
    assert.equal(fills.length, 1);
    assert.equal(fills[0].side, "buy");
    assert.equal(fills[0].wallet, user);
    assert.equal(fills[0].usd, 150);
  });

  it("dedupes the same sig/wallet/side", () => {
    const w = "Dupxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const a = fill({ wallet: w, side: "buy", tokenAmt: 1, usd: 1, at: 5, sig: "x" });
    assert.equal(dedupeFills([a, { ...a }]).length, 1);
  });

  it("merges GMGN usd onto an on-chain fill without changing the src or amount", () => {
    const w = "Merxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const onchain = fill({ wallet: w, side: "buy", tokenAmt: 10, usd: null, at: 5, sig: "same" });
    const gmgn = { ...fill({ wallet: w, side: "buy", tokenAmt: 10, usd: 7, at: 5, sig: "same" }), src: "gmgn" };
    const merged = mergeFillGaps([onchain], [gmgn]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].src, "test");
    assert.equal(merged[0].usd, 7);
    assert.equal(merged[0].tokenAmt, 10);
  });

  it("keeps on-chain usd when GMGN disagrees", () => {
    const w = "Keepxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const onchain = fill({ wallet: w, side: "buy", tokenAmt: 10, usd: 4, at: 5, sig: "same" });
    const gmgn = { ...fill({ wallet: w, side: "buy", tokenAmt: 10, usd: 99, at: 5, sig: "same" }), src: "gmgn" };
    assert.equal(mergeFillGaps([onchain], [gmgn])[0].usd, 4);
  });

  it("does not copy GMGN PnL into ROI when the payload also has realized_profit", () => {
    const w = "Pnlxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const book = bookWallet(w, [
      fill({ wallet: w, side: "buy", tokenAmt: 10, usd: 10, at: 1 }),
      fill({ wallet: w, side: "sell", tokenAmt: 10, usd: 13, at: 2, src: "gmgn" }),
    ]);
    assert.equal(book.profitUsd, 3);
    assert.equal(book.overallRoi, 0.3);
    assert.equal(book.gmgnLegs, 1);
    assert.equal(book.gap, false);
  });

  it("tags-only wallets stay gap with null ROI", () => {
    const w = "Tagxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const book = bookWallet(w, [], { labels: ["smart_degen"], balance: 50, priceUsd: 2 });
    assert.equal(book.gap, true);
    assert.equal(book.overallRoi, null);
    assert.equal(book.profitUsd, 0);
    assert.equal(book.remainingUsd, 0);
    assert.deepEqual(book.labels, ["smart_degen"]);
  });

  it("builds pump MC from virtual reserves", () => {
    const mc = pumpMcFromReserves(30e9, 1_000_000_000_000, 6, 1_000_000_000, 100);
    assert.ok(mc != null && mc > 0);
  });

  it("interpolates MC from OHLCV close * supply", () => {
    const mc = interpolateMc(1_700_000_500_000, [
      { t: 1_700_000_000, close: 0.00002 },
      { t: 1_700_001_000, close: 0.00003 },
    ], 1_000_000_000);
    assert.ok(mc != null);
    assert.ok(Math.abs((mc ?? 0) - 20_000) < 1);
  });

  it("classifies sold-all near zero remainder", () => {
    assert.equal(classify(100, 0), "sold_all");
    assert.equal(classify(100, 100), "hold");
    assert.equal(classify(100, 40), "partial");
  });
});
