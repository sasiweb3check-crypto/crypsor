import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cautionLevel, emptyMemory, fillOf, remember } from "./memory.ts";

describe("fillOf", () => {
  it("does not treat a carried print as live", () => {
    assert.equal(fillOf(18_000, 18_000), "live");
    assert.equal(fillOf(null, 18_000), "stale");
    assert.equal(fillOf(null, null), "missing");
  });
});

describe("remember", () => {
  it("ratchets missing holders and does not reset on one miss", () => {
    let m = emptyMemory();
    m = remember(m, {
      kind: "pulse",
      fill: { mc: "live", liq: "live", holders: "missing" },
      dump: false, exodus: false, disagree: false, quality: 70,
    });
    m = remember(m, {
      kind: "pulse",
      fill: { mc: "live", liq: "live", holders: "stale" },
      dump: false, exodus: false, disagree: false, quality: 70,
    });
    assert.ok(m.caution.missingHolders >= 2);
    assert.equal(cautionLevel(m), "wary");
    assert.ok(m.caution.notes.some((n) => n.includes("holders")));
  });

  it("needs two clean dumps-off before dumps fully clear", () => {
    let m = emptyMemory();
    m = remember(m, {
      kind: "pulse",
      fill: { mc: "live", liq: "live", holders: "live" },
      dump: true, exodus: false, disagree: false, quality: 70,
    });
    m = remember(m, {
      kind: "confirm",
      fill: { mc: "live", liq: "live", holders: "live" },
      dump: true, exodus: true, disagree: false, quality: 70,
    });
    assert.equal(cautionLevel(m), "blocked");
    m = remember(m, {
      kind: "confirm",
      fill: { mc: "live", liq: "live", holders: "live" },
      dump: false, exodus: false, disagree: false, quality: 80,
    });
    assert.ok(m.caution.dumps >= 1);
    assert.equal(cautionLevel(m), "wary");
  });
});
