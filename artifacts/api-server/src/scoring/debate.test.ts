import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  debateEntry, entrySatisfying, snapshotsVote, vitalsVote,
  type DebateInput,
} from "./debate.ts";

function input(over: Partial<DebateInput> = {}): DebateInput {
  return {
    score: 78,
    tradeOk: true,
    chase: false,
    dead: false,
    tapeLead: "buyers",
    mcUsd: 18_000,
    liqUsd: 7_500,
    holders: 140,
    top10Pct: 28,
    botHoldPct: 8,
    bundlerHoldPct: 12,
    quality: 72,
    flags: [],
    unknowns: [],
    walletBuys: 3,
    phase: "ward",
    pulseMcSlope: 0.08,
    confirmMcSlope: 0.03,
    pulseHolderSlope: 0.02,
    confirmHolderSlope: 0.01,
    pulseTape: "buyers",
    confirmTape: "buyers",
    ...over,
  };
}

describe("entrySatisfying", () => {
  it("wants a mid-low cap with real liq", () => {
    assert.equal(entrySatisfying(18_000, 6_000).ok, true);
    assert.equal(entrySatisfying(4_000, 6_000).ok, false);
    assert.equal(entrySatisfying(80_000, 20_000).ok, false);
    assert.equal(entrySatisfying(18_000, 1_000).ok, false);
  });
});

describe("debateEntry", () => {
  it("locks when four desks agree and the entry is in zone", () => {
    const d = debateEntry(input());
    assert.equal(d.action, "lock");
    assert.equal(d.agreed, true);
    assert.ok(d.yes >= 3);
  });

  it("watches when the gate is open but entry MC is too high", () => {
    const d = debateEntry(input({ mcUsd: 90_000, liqUsd: 20_000 }));
    assert.equal(d.action, "watch");
    assert.equal(d.entryOk, false);
    assert.ok(d.headline.includes("WATCH"));
  });

  it("watches when quality feeds disagree", () => {
    const d = debateEntry(input({ flags: ["mc_disagree"], quality: 48 }));
    assert.equal(d.action, "watch");
    assert.ok(d.votes.some((v) => v.agent === "quality" && v.vote === "no"));
  });

  it("passes a dead mint", () => {
    assert.equal(debateEntry(input({ dead: true, tradeOk: false, score: 40 })).action, "pass");
  });
  it("does not lock a chase even if other desks are warm", () => {
    const chase = debateEntry(input({ chase: true, tradeOk: false, score: 50 }));
    assert.notEqual(chase.action, "lock");
    assert.ok(chase.votes.some((v) => v.vote === "no"));
  });

  it("snapshots veto a dump even if vitals like it", () => {
    const v = snapshotsVote(input({ pulseMcSlope: -0.2, confirmMcSlope: -0.22, pulseHolderSlope: -0.1 }));
    assert.equal(v.vote, "no");
    const d = debateEntry(input({
      pulseMcSlope: -0.2, confirmMcSlope: -0.22, pulseHolderSlope: -0.12, confirmHolderSlope: -0.11,
    }));
    assert.notEqual(d.action, "lock");
  });

  it("vitals vote no in ICU", () => {
    assert.equal(vitalsVote(input({ phase: "icu", tradeOk: false, score: 40 })).vote, "no");
  });
});
