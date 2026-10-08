import { test } from "node:test";
import assert from "node:assert/strict";
import { scanDiagnostics } from "./diagnostics.ts";
import { SOL, type Transaction } from "./buys.ts";
test("diagnostics distinguish purchased assets from quote-only swap outputs", () => {
  const swap = (mint: string, signature: string): Transaction => ({
    signature,
    timestamp: 1700000000,
    type: "SWAP",
    events: {
      swap: {
        nativeInput: { account: "wallet", amount: 1 },
        tokenOutputs: [
          {
            mint,
            userAccount: "wallet",
            rawTokenAmount: { tokenAmount: "1", decimals: 0 },
          },
        ],
      },
    },
  });
  const report = scanDiagnostics(
    [swap("asset", "buy"), swap(SOL, "quote")],
    "wallet",
  );
  assert.equal(report.reasons["purchase-recognized"], 1);
  assert.equal(report.reasons["no-nonquote-wallet-output"], 1);
  assert.equal(report.samples[0].signature, "quote");
});
test("unrecognized routes are explained without admitting a transferred token", () => {
  const report = scanDiagnostics(
    [
      {
        signature: "route",
        timestamp: 1700000000,
        type: "SWAP",
        tokenTransfers: [
          {
            mint: "asset",
            toUserAccount: "wallet",
            fromUserAccount: "vault",
            tokenAmount: 1,
          },
        ],
        nativeTransfers: [
          { fromUserAccount: "wallet", toUserAccount: "router", amount: 1 },
        ],
      },
    ],
    "wallet",
  );
  assert.equal(report.reasons["swap-routing-not-recognized"], 1);
  assert.equal(report.reasons["purchase-recognized"], undefined);
});
test("diagnostics retain bounded samples with only explicit transaction fields", () => {
  const tx = {
    signature: "transfer",
    timestamp: 1700000000,
    type: "TRANSFER",
    unexpected: "do not persist",
  };
  const report = scanDiagnostics(
    Array.from({ length: 100 }, () => tx),
    "wallet",
  );
  assert.equal(report.checked, 100);
  assert.equal(report.samples.length, 1);
  assert.equal(report.samples[0].unexpected, undefined);
});
