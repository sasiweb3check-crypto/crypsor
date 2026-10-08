import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractBuys, type Transaction } from "./buys.ts";
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/pump-buy-v2.json", import.meta.url), "utf8"),
);
const tx = (): Transaction => ({
  signature: fixture.signature,
  timestamp: fixture.timestamp,
  type: "UNKNOWN",
  instructions: [structuredClone(fixture.instruction)],
});
function encode(bytes: Buffer) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + bytes.toString("hex")),
    result = "";
  while (n > 0n) {
    result = alphabet[Number(n % 58n)] + result;
    n /= 58n;
  }
  return result;
}
test("confirmed public Token-2022 buy_v2 is discovered even with UNKNOWN label and missing transfers", () => {
  const t = tx();
  t.tokenTransfers = [
    { mint: "spam", toUserAccount: fixture.wallet, tokenAmount: 100 },
  ];
  const buys = extractBuys(t, fixture.wallet);
  assert.equal(buys.length, 1);
  assert.equal(buys[0].mint, fixture.mint);
  assert.equal(buys[0].purchasePrice, null);
});
test("Pump purchase rejects failed calls, different wallet and counterfeit program", () => {
  assert.deepEqual(
    extractBuys(
      { ...tx(), transactionError: { error: "failed" } },
      fixture.wallet,
    ),
    [],
  );
  assert.deepEqual(extractBuys(tx(), "different-wallet"), []);
  const t = tx();
  t.instructions![0].programId = "11111111111111111111111111111111";
  assert.deepEqual(extractBuys(t, fixture.wallet), []);
});
test("Pump sells, invalid instruction data and zero purchase amount are excluded", () => {
  for (const data of [
    "invalid_",
    encode(Buffer.alloc(24)),
    encode(
      Buffer.concat([
        Buffer.from([184, 23, 238, 97, 103, 197, 211, 61]),
        Buffer.alloc(16),
      ]),
    ),
    encode(
      Buffer.concat([
        Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]),
        Buffer.alloc(16, 1),
      ]),
    ),
  ]) {
    const t = tx();
    t.instructions![0].data = data;
    assert.deepEqual(extractBuys(t, fixture.wallet), []);
  }
});
test("an inner Pump call alone cannot prove purchase because its caller may catch failure", () => {
  const t = tx();
  t.instructions = [{ programId: "router", innerInstructions: t.instructions }];
  assert.deepEqual(extractBuys(t, fixture.wallet), []);
});
test("v3 Pump buy layouts use their documented user account index", () => {
  const t = tx(),
    i = t.instructions![0];
  i.accounts = Array(17).fill("unused");
  i.accounts[1] = fixture.mint;
  i.accounts[8] = fixture.wallet;
  const bytes = Buffer.alloc(24);
  Buffer.from([7, 5, 29, 196, 245, 23, 101, 80]).copy(bytes);
  bytes.writeBigUInt64LE(1n, 8);
  i.data = encode(bytes);
  assert.equal(extractBuys(t, fixture.wallet)[0].mint, fixture.mint);
});
