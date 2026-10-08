import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBuys, USDC, type Transaction } from "./buys.ts";
const wallet = "wallet";
const token = (
  mint: string,
  amount: string,
  decimals = 6,
  userAccount = wallet,
) => ({ mint, userAccount, rawTokenAmount: { tokenAmount: amount, decimals } });
const swap = (changes: Partial<Transaction> = {}): Transaction => ({
  signature: "sig",
  timestamp: 1700000000,
  type: "SWAP",
  events: {
    swap: {
      nativeInput: { account: wallet, amount: "1" },
      tokenOutputs: [token("mint", "1000000")],
    },
  },
  ...changes,
});
test("accepts confirmed buys of any spend size", () =>
  assert.equal(extractBuys(swap(), wallet).length, 1));
test("rejects simple incoming transfers", () =>
  assert.deepEqual(extractBuys(swap({ type: "TRANSFER" }), wallet), []));
test("rejects failed swaps", () =>
  assert.deepEqual(
    extractBuys(swap({ transactionError: { error: "failed" } }), wallet),
    [],
  ));
test("requires the tracked wallet to pay", () =>
  assert.deepEqual(
    extractBuys(
      swap({
        events: {
          swap: {
            nativeInput: { account: "other", amount: "100" },
            tokenOutputs: [token("mint", "1")],
          },
        },
      }),
      wallet,
    ),
    [],
  ));
test("ignores spam transfers alongside a real swap", () =>
  assert.deepEqual(
    extractBuys(
      swap({
        tokenTransfers: [
          { mint: "spam", toUserAccount: wallet, tokenAmount: 10 },
        ],
      }),
      wallet,
    ).map((b) => b.mint),
    ["mint"],
  ));
test("does not admit a spam mint missing from parsed swap output", () =>
  assert.deepEqual(
    extractBuys(
      swap({
        events: {
          swap: {
            nativeInput: { account: wallet, amount: "1" },
            tokenOutputs: [token("actual", "1", 0)],
          },
        },
        tokenTransfers: [
          { mint: "spam", toUserAccount: wallet, tokenAmount: 10 },
        ],
      }),
      wallet,
    ).map((b) => b.mint),
    ["actual"],
  ));
test("calculates USD entry from stablecoin input and actual quantity", () => {
  const [buy] = extractBuys(
    swap({
      events: {
        swap: {
          tokenInputs: [token(USDC, "10000000")],
          tokenOutputs: [token("mint", "2000000")],
        },
      },
    }),
    wallet,
  );
  assert.equal(buy.purchasePrice, 5);
});
test("SOL buys leave USD purchase price unknown for detection fallback", () =>
  assert.equal(extractBuys(swap(), wallet)[0].purchasePrice, null));
test("keeps every confirmed output without scoring or spend minimum", () =>
  assert.deepEqual(
    extractBuys(
      swap({
        events: {
          swap: {
            nativeInput: { account: wallet, amount: "1" },
            tokenOutputs: [token("one", "1", 0), token("two", "1", 0)],
          },
        },
      }),
      wallet,
    ).map((b) => b.mint),
    ["one", "two"],
  ));
test("does not treat rent-only balance changes as a buy", () =>
  assert.deepEqual(
    extractBuys(
      swap({
        events: undefined,
        tokenTransfers: [
          {
            mint: "mint",
            fromUserAccount: "sender",
            toUserAccount: wallet,
            tokenAmount: 1,
          },
        ],
        nativeTransfers: [
          { fromUserAccount: wallet, toUserAccount: "rent", amount: 2039280 },
        ],
      }),
      wallet,
    ),
    [],
  ));
test("rejects ambiguous multiple inbound mints without swap events", () =>
  assert.deepEqual(
    extractBuys(
      swap({
        events: undefined,
        tokenTransfers: [
          {
            mint: "one",
            fromUserAccount: "pool",
            toUserAccount: wallet,
            tokenAmount: 1,
          },
          {
            mint: "spam",
            fromUserAccount: "other",
            toUserAccount: wallet,
            tokenAmount: 1,
          },
        ],
        nativeTransfers: [
          { fromUserAccount: wallet, toUserAccount: "pool", amount: 1 },
        ],
      }),
      wallet,
    ),
    [],
  ));
test("fallback requires spend to the same counterparty as the token receipt", () => {
  const tx = swap({
    events: undefined,
    tokenTransfers: [
      {
        mint: "mint",
        fromUserAccount: "pool",
        toUserAccount: wallet,
        tokenAmount: 2,
      },
      {
        mint: USDC,
        fromUserAccount: wallet,
        toUserAccount: "pool",
        tokenAmount: 10,
      },
    ],
  });
  assert.equal(extractBuys(tx, wallet)[0].purchasePrice, 5);
});
test("does not treat a sell into SOL or stablecoin as token discovery", () =>
  assert.deepEqual(
    extractBuys(
      swap({
        events: {
          swap: {
            tokenInputs: [token("mint", "100")],
            tokenOutputs: [token(USDC, "100")],
          },
        },
      }),
      wallet,
    ),
    [],
  ));
test("swap outputs belonging to another wallet are excluded", () =>
  assert.deepEqual(
    extractBuys(
      swap({
        events: {
          swap: {
            nativeInput: { account: wallet, amount: "1" },
            tokenOutputs: [token("mint", "1", 0, "other")],
          },
        },
      }),
      wallet,
    ),
    [],
  ));
