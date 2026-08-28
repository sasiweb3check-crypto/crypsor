import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planExit, multiple, type ExitInput } from "./exit.ts";

function input(over: Partial<ExitInput> = {}): ExitInput {
  return {
    entryMc: 20_000,
    lastMc: 22_000,
    peakMc: 22_000,
    phase: "ward",
    tapeLead: "buyers",
    dead: false,
    liqUsd: 10_000,
    liqSlope: 0.02,
    holderSlope: 0.01,
    ...over,
  };
}

describe("planExit", () => {
  it("locks multiples off entry MC", () => {
    assert.equal(multiple(40_000, 20_000), 2);
    assert.equal(multiple(null, 20_000), null);
  });

  it("flattens a dead book", () => {
    const p = planExit(input({ dead: true, lastMc: 8_000 }));
    assert.equal(p.action, "exit");
    assert.equal(p.takePct, 100);
  });

  it("cuts when under entry with sellers", () => {
    const p = planExit(input({ lastMc: 12_000, peakMc: 14_000, tapeLead: "sellers" }));
    assert.equal(p.action, "exit");
    assert.ok(p.title.toLowerCase().includes("cut"));
  });

  it("trims half after 2× then 30% giveback", () => {
    const p = planExit(input({ lastMc: 28_000, peakMc: 44_000, tapeLead: "buyers" }));
    assert.equal(p.action, "trim");
    assert.equal(p.takePct, 50);
    assert.ok((p.athX ?? 0) >= 2);
  });

  it("lets a 2× runner hold while buyers lead", () => {
    const p = planExit(input({ lastMc: 48_000, peakMc: 50_000, tapeLead: "buyers" }));
    assert.equal(p.action, "hold");
    assert.equal(p.takePct, 0);
  });

  it("exits ICU before it paid", () => {
    const p = planExit(input({ phase: "icu", lastMc: 21_000, peakMc: 21_000 }));
    assert.equal(p.action, "exit");
  });
});
