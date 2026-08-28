import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CHASE_6H_PCT, MC_SUGGEST_MIN, decide, emptyCandidate, evaluateRules, isFakeChart,
  newbornFaded, nextPhase, ruleLabel, tapeLead, type OmoCandidate,
} from "./omo.ts";

const ruleOf = (c: OmoCandidate, id: string) =>
  evaluateRules(c).rules.find((r) => r.id === id);

describe("evaluateRules (omo gate)", () => {
  it("passes every rule on a healthy wallet-buy candidate", () => {
    const { rules } = evaluateRules(emptyCandidate());
    assert.deepEqual(rules.filter((r) => !r.pass).map((r) => r.id), []);
  });

  it("refuses a thin pool", () => {
    assert.equal(ruleOf(emptyCandidate({ liquidityUsd: 4_000 }), "liquidity_floor")?.pass, false);
  });

  it("refuses a dead tape", () => {
    assert.equal(ruleOf(emptyCandidate({ vol1h: 500 }), "volume_alive")?.pass, false);
  });

  it("refuses when sells lead buys", () => {
    assert.equal(ruleOf(emptyCandidate({ buys1h: 10, sells1h: 90 }), "buy_pressure")?.pass, false);
  });

  it("refuses a newborn already bleeding", () => {
    assert.equal(
      ruleOf(emptyCandidate({ ageHours: 3, chg1h: -40 }), "not_newborn_fade")?.pass,
      false,
    );
  });

  it("allows an older token that is down on the hour", () => {
    assert.equal(
      ruleOf(emptyCandidate({ ageHours: 400, chg1h: -40 }), "not_newborn_fade")?.pass,
      true,
    );
  });

  it("refuses a ticker with no public presence", () => {
    assert.equal(
      ruleOf(emptyCandidate({ socials: [], hasSite: false }), "public_presence")?.pass,
      false,
    );
  });

  it("refuses when no tracked wallet bought", () => {
    assert.equal(ruleOf(emptyCandidate({ walletBuys: 0 }), "wallet_heat")?.pass, false);
  });

  it("refuses a name already on the book", () => {
    assert.equal(ruleOf(emptyCandidate({ held: true }), "already_held")?.pass, false);
  });

  it("has a human label for every rule", () => {
    for (const rule of evaluateRules(emptyCandidate()).rules) {
      assert.notEqual(ruleLabel(rule.id), rule.id);
    }
  });
});

describe("livable market cap — never suggest ~$2k rugs", () => {
  it("refuses a 2k MC print as already rugged", () => {
    const r = ruleOf(emptyCandidate({ mcUsd: 2_100, fdv: 2_100 }), "livable_mc");
    assert.equal(r?.pass, false);
    assert.match(r?.detail ?? "", /rug zone|floor/i);
    const d = decide(emptyCandidate({ mcUsd: 2_100, fdv: 2_100 }));
    assert.equal(d.tradeOk, false);
    assert.notEqual(d.call, "buying");
    assert.ok(d.checks.some((c) => c.hold === false && /rugged|rug/i.test(c.text)));
  });

  it("refuses missing market cap instead of inventing one", () => {
    const r = ruleOf(emptyCandidate({ mcUsd: 0, fdv: 0 }), "livable_mc");
    assert.equal(r?.pass, false);
    assert.match(r?.detail ?? "", /will not invent/i);
  });

  it("allows a low-cap above the suggest floor", () => {
    assert.ok(MC_SUGGEST_MIN >= 8_000);
    assert.equal(ruleOf(emptyCandidate({ mcUsd: 12_000, fdv: 12_000 }), "livable_mc")?.pass, true);
    const d = decide(emptyCandidate({ mcUsd: 12_000, fdv: 12_000 }));
    assert.equal(d.call, "buying");
  });
});

describe("omo tape + chase", () => {
  it("calls two-sided when nobody leads 1.15×", () => {
    assert.equal(tapeLead(50, 50), "two_sided");
    assert.equal(tapeLead(80, 30), "buyers");
    assert.equal(tapeLead(10, 40), "sellers");
  });

  it("refuses chase on a 6h rocket", () => {
    const d = decide(emptyCandidate({ chg6h: CHASE_6H_PCT + 10, buys6h: 800, sells6h: 200 }));
    assert.equal(d.chase, true);
    assert.equal(ruleOf(emptyCandidate({ chg6h: 369 }), "not_chase")?.pass, false);
    assert.equal(d.call, "pass");
    assert.ok(d.checks.some((c) => /clean an exit|chase/i.test(c.text)));
  });

  it("does not invent a pass from unread tape", () => {
    const d = decide(emptyCandidate({
      vol1h: 0, buys1h: 0, sells1h: 0, vol5m: 0, flags: ["dex_missing"], source: "pump",
    }));
    assert.equal(d.tapeLead, "unknown");
    assert.equal(d.tradeOk, false);
    assert.equal(d.quality, "fallback");
    assert.match(d.qualityNote ?? "", /data quality is less/i);
    assert.ok(d.checks.some((c) => c.hold === null && /unread|invent|verified/i.test(c.text)));
  });
});

describe("fake chart / newborn fade (omo market filters)", () => {
  it("flags a wash tape as fake", () => {
    assert.equal(isFakeChart({
      vol1h: 80_000, vol5m: 20_000, vol6h: 200_000, vol24h: 400_000,
      buys1h: 10, sells1h: 5, chg1h: 12, chg6h: 40, chg24h: 80,
      liquidityUsd: 20_000, fdv: 80_000, ageHours: 8,
    }), true);
  });

  it("forgets a quiet newborn", () => {
    assert.equal(newbornFaded({
      ageHours: 6, vol1h: 400, vol5m: 0, vol24h: 20_000, buys1h: 4, sells1h: 3,
    }), true);
  });
});

describe("decide + phase", () => {
  it("buys only when the full gate passes and buyers lead", () => {
    const d = decide(emptyCandidate());
    assert.equal(d.call, "buying");
    assert.equal(d.tradeOk, true);
    assert.ok(d.checks.filter((c) => c.hold === true).length >= 2);
  });

  it("stalks a livable name when the hour is two-sided", () => {
    const d = decide(emptyCandidate({ buys1h: 80, sells1h: 78 }));
    assert.equal(d.call, "stalking");
    assert.equal(d.tradeOk, false);
  });

  it("passes when sellers lead", () => {
    const d = decide(emptyCandidate({ buys1h: 10, sells1h: 90 }));
    assert.equal(d.call, "pass");
    assert.equal(nextPhase("ward", d), "icu");
  });

  it("marks a 2k print deceased rather than a trade", () => {
    const d = decide(emptyCandidate({ mcUsd: 1_800, fdv: 1_800, liquidityUsd: 200 }));
    assert.equal(d.dead, true);
    assert.equal(nextPhase("intake", d), "deceased");
  });

  it("holds a name already on the book", () => {
    const d = decide(emptyCandidate({ held: true }));
    assert.equal(d.call, "holding");
  });
});
