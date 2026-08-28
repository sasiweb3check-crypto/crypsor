import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isWalletSwapBuy, MIN_SOL_SPEND_LAMPORTS, type HeliusTx } from "./helius.ts";

const WALLET = "Wallet1111111111111111111111111111111111111";
const MINT = "Nvda111111111111111111111111111111111111111";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function tx(over: Partial<HeliusTx> & Pick<HeliusTx, "tokenTransfers">): HeliusTx {
  return { signature: "sig", timestamp: 1, type: "UNKNOWN", ...over };
}

describe("isWalletSwapBuy", () => {
  it("rejects a receive / airdrop even when Helius labels it SWAP", () => {
    const receive = tx({
      type: "SWAP",
      tokenTransfers: [{ mint: MINT, toUserAccount: WALLET, tokenAmount: 1_000 }],
      nativeTransfers: [],
    });
    assert.equal(isWalletSwapBuy(receive, WALLET, MINT), false);
  });

  it("rejects ATA-rent dust SOL with a token in", () => {
    const dust = tx({
      type: "SWAP",
      tokenTransfers: [{ mint: MINT, toUserAccount: WALLET, tokenAmount: 50 }],
      nativeTransfers: [{ fromUserAccount: WALLET, amount: 2_039_280 }],
    });
    assert.equal(isWalletSwapBuy(dust, WALLET, MINT), false);
    assert.ok(2_039_280 < MIN_SOL_SPEND_LAMPORTS);
  });

  it("accepts SOL spent above dust plus the mint in", () => {
    const buy = tx({
      type: "UNKNOWN",
      tokenTransfers: [{ mint: MINT, toUserAccount: WALLET, tokenAmount: 100 }],
      nativeTransfers: [{ fromUserAccount: WALLET, amount: 50_000_000 }],
    });
    assert.equal(isWalletSwapBuy(buy, WALLET, MINT), true);
  });

  it("accepts USDC spent plus the mint in", () => {
    const buy = tx({
      type: "TRANSFER",
      tokenTransfers: [
        { mint: USDC, fromUserAccount: WALLET, tokenAmount: 12.5 },
        { mint: MINT, toUserAccount: WALLET, tokenAmount: 800 },
      ],
    });
    assert.equal(isWalletSwapBuy(buy, WALLET, MINT), true);
  });

  it("accepts a large negative nativeBalanceChange as SOL spend", () => {
    const buy = tx({
      tokenTransfers: [{ mint: MINT, toUserAccount: WALLET, tokenAmount: 1 }],
      accountData: [{ account: WALLET, nativeBalanceChange: -10_000_000 }],
    });
    assert.equal(isWalletSwapBuy(buy, WALLET, MINT), true);
  });

  it("rejects a SWAP that received a different mint", () => {
    const other = tx({
      type: "SWAP",
      tokenTransfers: [{ mint: MINT, toUserAccount: WALLET, tokenAmount: 1 }],
      nativeTransfers: [{ fromUserAccount: WALLET, amount: 50_000_000 }],
    });
    assert.equal(isWalletSwapBuy(other, WALLET, "OtherMint11111111111111111111111111111111"), false);
  });
});
