import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bookWallet, mergeFillGaps } from "../scoring/scout-fills.ts";
import { extractLabels } from "./gmgn-client.ts";
import {
  labelsFromGmgnRows, parseGmgnActivityRows, parseGmgnTradeRows, walletsFromGmgnRows,
} from "./gmgn-tape.ts";

const MINT = "Mintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const W = "Traderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const OTHER = "Tokbxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

describe("gmgn tape parsers", () => {
  it("parses quotation-style trades into fills and ignores realized_profit", () => {
    const fills = parseGmgnTradeRows([
      {
        tx_hash: "sigA",
        timestamp: 1_700_000_000,
        wallet_address: W,
        event: "buy",
        token_amount: 40,
        volume_usd: 12,
        price_usd: 0.3,
        wallet_tag: ["smart_degen", "sniper"],
        realized_profit: 88_000,
      },
      {
        signature: "sigB",
        timestamp: 1_700_000_010,
        maker: W,
        side: "sell",
        amount: 40,
        usd_value: 20,
        tags: ["kol"],
      },
    ], { mint: MINT });
    assert.equal(fills.length, 2);
    assert.equal(fills[0].wallet, W);
    assert.equal(fills[0].side, "buy");
    assert.equal(fills[0].tokenAmt, 40);
    assert.equal(fills[0].usd, 12);
    assert.equal(fills[0].src, "gmgn");
    assert.equal(fills[0].sig, "sigA");
    assert.equal(fills[1].side, "sell");
    assert.equal(fills[1].usd, 20);
    const labels = labelsFromGmgnRows([
      { wallet_address: W, wallet_tag: ["smart_degen", "sniper"] },
      { maker: W, tags: ["kol"] },
    ]);
    assert.ok(labels.get(W)?.includes("smart_degen"));
    assert.ok(labels.get(W)?.includes("sniper"));
    assert.ok(labels.get(W)?.includes("kol"));
  });

  it("parses Dragon early-buyer history (maker + event + amount_usd)", () => {
    const fills = parseGmgnTradeRows([
      {
        event: "buy",
        maker: W,
        token_amount: 1000,
        amount_usd: 8.5,
        timestamp: 1_700_000_100,
        tx_hash: "early1",
        maker_token_tags: ["sniper"],
        realized_profit: 50,
        unrealized_profit: 12,
      },
    ]);
    assert.equal(fills.length, 1);
    assert.equal(fills[0].usd, 8.5);
    assert.notEqual(fills[0].usd, 50);
  });

  it("discovers holder/trader wallets without turning PnL into fills", () => {
    const { wallets, labels } = walletsFromGmgnRows([
      {
        address: W,
        amount_percentage: 4.2,
        realized_profit: 12_000,
        total_cost: 400,
        profit_change: 30,
        tags: ["smart_money"],
      },
    ]);
    assert.deepEqual(wallets, [W]);
    assert.ok(labels.get(W)?.includes("smart_money"));
    assert.equal(parseGmgnTradeRows([{
      address: W,
      realized_profit: 12_000,
      total_cost: 400,
    }]).length, 0);
  });

  it("keeps wallet activity for this mint and drops other tokens", () => {
    const rows = [
      {
        eventType: "buy",
        transaction_hash: "t1",
        timestamp: 1_700_000_200,
        token: { address: MINT, amount: 9 },
        cost_usd: 3,
        maker: W,
      },
      {
        type: "sell",
        transaction_hash: "t2",
        timestamp: 1_700_000_300,
        token_address: OTHER,
        token_amount: 9,
        costUsd: 4,
      },
    ];
    const fills = parseGmgnActivityRows(rows, W, MINT);
    assert.equal(fills.length, 1);
    assert.equal(fills[0].sig, "t1");
    assert.equal(fills[0].usd, 3);
    assert.equal(fills[0].tokenAmt, 9);
  });

  it("does not read profile PnL into labels", () => {
    const labels = extractLabels({
      tags: ["whale"],
      twitter_name: "alice",
      realized_profit: 999,
      pnl_7d: 12,
      total_profit: 4,
    });
    assert.ok(labels.includes("whale"));
    assert.ok(labels.some((l) => l.startsWith("name:alice")));
    assert.ok(!labels.some((l) => l.includes("999") || l.includes("pnl")));
  });

  it("rebuilds ROI from merged GMGN fills, not from a PnL field", () => {
    const onchain = [{
      wallet: W, side: "buy" as const, tokenAmt: 10, usd: 10, at: 1, sig: "a", mc: null, src: "pump",
    }];
    const gmgn = parseGmgnTradeRows([{
      maker: W, event: "sell", token_amount: 10, amount_usd: 18, timestamp: 2, tx_hash: "b", realized_profit: 5000,
    }]);
    const merged = mergeFillGaps(onchain, gmgn);
    const book = bookWallet(W, merged, { labels: ["smart_degen"] });
    assert.equal(book.profitUsd, 8);
    assert.equal(book.overallRoi, 0.8);
    assert.equal(book.gmgnLegs, 1);
    assert.deepEqual(book.labels, ["smart_degen"]);
    assert.notEqual(book.profitUsd, 5000);
  });
});
