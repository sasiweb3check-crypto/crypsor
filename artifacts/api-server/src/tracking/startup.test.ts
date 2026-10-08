import { test } from "node:test";
import assert from "node:assert/strict";
import { retryStartup } from "./startup.ts";
test("startup recovers when reserved PostgreSQL slots become available", async () => {
  let calls = 0;
  const waits: number[] = [];
  await retryStartup(
    async () => {
      if (++calls < 3)
        throw Object.assign(new Error("slots reserved"), { code: "53300" });
    },
    {
      wait: async (ms) => {
        waits.push(ms);
      },
    },
  );
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
});
test("startup retry is bounded if the connection budget stays exhausted", async () => {
  let calls = 0;
  const error = Object.assign(new Error("slots reserved"), { code: "53300" });
  await assert.rejects(
    retryStartup(
      async () => {
        calls++;
        throw error;
      },
      { attempts: 3, wait: async () => {} },
    ),
    (e) => e === error,
  );
  assert.equal(calls, 3);
});
test("invalid credentials and TLS failures are not retried or bypassed", async () => {
  for (const code of ["28P01", "SELF_SIGNED_CERT_IN_CHAIN", "3D000"]) {
    let calls = 0;
    await assert.rejects(
      retryStartup(
        async () => {
          calls++;
          throw Object.assign(new Error("configuration invalid"), { code });
        },
        {
          wait: async () => {
            assert.fail("must not retry");
          },
        },
      ),
    );
    assert.equal(calls, 1);
  }
});
