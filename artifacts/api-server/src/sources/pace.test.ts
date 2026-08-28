import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pace } from "./pace.ts";

describe("pace", () => {
  it("waits at least the gap on a second call", async () => {
    const key = `t-${Date.now()}`;
    await pace(key, 0);
    const t0 = Date.now();
    await pace(key, 40);
    assert.ok(Date.now() - t0 >= 30);
  });
});
