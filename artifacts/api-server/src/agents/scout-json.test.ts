import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sqlJson } from "./scout-json.ts";

describe("scout jsonb params", () => {
  it("encodes note arrays as JSON, not Postgres text[]", () => {
    const notes = [
      "MC at each fill is curve reserves (pump) or OHLCV close × supply (DEX). Supply is treated as fixed.",
      "Sold-all wallets only appear if they swapped with the pool or pump curve we crawled.",
    ];
    const raw = sqlJson(notes);
    assert.equal(typeof raw, "string");
    assert.equal(raw?.startsWith("["), true);
    assert.equal(raw?.startsWith("{"), false);
    assert.deepEqual(JSON.parse(raw!), notes);
  });

  it("drops NaN and null bytes so jsonb will accept the payload", () => {
    const raw = sqlJson({
      priceUsd: Number.NaN,
      mcUsd: Number.POSITIVE_INFINITY,
      name: "MONA\u0000",
      notes: ["ok"],
    });
    const parsed = JSON.parse(raw!);
    assert.equal(parsed.priceUsd, null);
    assert.equal(parsed.mcUsd, null);
    assert.equal(parsed.name, "MONA");
    assert.deepEqual(parsed.notes, ["ok"]);
  });
});
