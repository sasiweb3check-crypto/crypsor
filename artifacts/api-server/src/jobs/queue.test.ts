import { test } from "node:test";
import assert from "node:assert/strict";
import { retryDelay } from "./queue.ts";
import { priceInterval } from "../tracking/worker.ts";
import { parseCursor } from "../tracking/queries.ts";
test("rate-limit backoff honors provider Retry-After", () =>
  assert.ok(retryDelay(0, 60_000) >= 60_000));
test("repeated failures have bounded exponential backoff", () => {
  assert.ok(retryDelay(7) > retryDelay(0));
  assert.ok(retryDelay(30) < 300_250);
});
test("fresh discoveries and viewed tokens refresh frequently", () => {
  const now = Date.now();
  assert.equal(
    priceInterval({ detected_at: new Date(now - 1000).toISOString() }, now),
    30,
  );
  assert.equal(
    priceInterval(
      {
        detected_at: "2020-01-01",
        last_viewed_at: new Date(now - 1000).toISOString(),
      },
      now,
    ),
    30,
  );
});
test("old tokens remain stored with slower price schedules", () =>
  assert.equal(
    priceInterval({ detected_at: "2020-01-01" }, Date.now()),
    86400,
  ));
test("cursor cannot be reused for a different search or sort", () => {
  const c = Buffer.from(
    JSON.stringify({
      sort: "recent",
      query: "one",
      wallet: "",
      mint: "mint",
      value: "2026-01-01",
    }),
  ).toString("base64url");
  assert.equal(parseCursor(c, "recent", "one", "").mint, "mint");
  assert.throws(() => parseCursor(c, "gain", "one", ""), /Invalid/);
  assert.throws(() => parseCursor(c, "recent", "two", ""), /Invalid/);
});
test("invalid timestamps and cursor payloads are rejected", () => {
  assert.throws(() => parseCursor("not-json", "recent", "", ""), /Invalid/);
  const c = Buffer.from(
    JSON.stringify({
      sort: "recent",
      query: "",
      wallet: "",
      mint: "mint",
      value: "invalid",
    }),
  ).toString("base64url");
  assert.throws(() => parseCursor(c, "recent", "", ""), /Invalid/);
});
