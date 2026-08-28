import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canLockPass } from "./entry.ts";

describe("canLockPass", () => {
  it("refuses a lock without a tracked-wallet buy", () => {
    assert.equal(canLockPass(0), false);
    assert.equal(canLockPass(-1), false);
  });

  it("allows a lock once a tracked wallet has swapped in", () => {
    assert.equal(canLockPass(1), true);
    assert.equal(canLockPass(3), true);
  });
});
