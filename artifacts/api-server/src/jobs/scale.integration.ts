import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !["127.0.0.1", "localhost"].includes(new URL(testUrl).hostname))
  throw new Error(
    "Set TEST_DATABASE_URL to an isolated loopback test database",
  );
process.env.DATABASE_URL = testUrl;
delete process.env.AIVEN_DATABASE_URL;
process.env.HELIUS_API_KEY = "fixture";
process.env.HELIUS_RPS = "1000";
process.env.DEXSCREENER_RPS = "1000";
process.env.SOLANA_RPC_RPS = "1000";
process.env.WALLET_PAGES_PER_JOB = "1";
const { pool, initialize } = await import("../tracking/store.ts");
const { ingestTransactions } = await import("../tracking/ingest.ts");
const { syncWallet, refreshPrices, enrichMetadata, computeIntelligence } =
  await import("../tracking/worker.ts");
const { summary, invalidateSummary, tokenPage, tokenDetail } =
  await import("../tracking/queries.ts");
const {
  enqueue,
  claim,
  finish,
  fail,
  recover,
  processOne,
  consumers,
  closeQueue,
  relay,
} = await import("./queue.ts");
const { request } = await import("../services/providers.ts");
const originalFetch = globalThis.fetch;
const tx = (
  wallet: string,
  mint: string,
  signature: string,
  timestamp = 1700000000,
) => ({
  signature,
  timestamp,
  type: "SWAP",
  events: {
    swap: {
      nativeInput: { account: wallet, amount: "1" },
      tokenOutputs: [
        {
          mint,
          userAccount: wallet,
          rawTokenAmount: { tokenAmount: "1", decimals: 0 },
        },
      ],
    },
  },
});
before(async () => {
  await initialize();
  await initialize();
});
beforeEach(async () => {
  globalThis.fetch = originalFetch;
  await pool.query(
    "TRUNCATE cw_buys,cw_tokens,cw_wallets,cw_token_wallets,cw_jobs,cw_insights,cw_prices,cw_receipts,cw_rate_limits,cw_workers,cw_wallet_stats CASCADE",
  );
  await pool.query(
    "UPDATE cw_stats SET tokens=0,priced=0,positive=0,gain_sum=0",
  );
  invalidateSummary();
});
after(async () => {
  globalThis.fetch = originalFetch;
  await closeQueue();
  await pool.end();
});
test("duplicate concurrent deliveries count once and preserve fixed entry and sampled peak", async () => {
  await pool.query("INSERT INTO cw_wallets(address) VALUES('wallet')");
  const transactions = [tx("wallet", "mint", "sig")];
  await Promise.all([
    ingestTransactions("wallet", transactions),
    ingestTransactions("wallet", transactions),
  ]);
  let price = 2;
  globalThis.fetch = async () =>
    Response.json([
      {
        chainId: "solana",
        baseToken: { address: "mint", name: "Name", symbol: "SYM" },
        priceUsd: String(price),
        liquidity: { usd: 100 },
      },
    ]);
  await refreshPrices(["mint"]);
  price = 4;
  await refreshPrices(["mint"]);
  price = 3;
  await refreshPrices(["mint"]);
  await computeIntelligence("mint");
  const t = await tokenDetail("mint");
  assert.equal(t.entry_price, 2);
  assert.equal(t.gain, 50);
  assert.equal(t.peak_gain, 100);
  assert.equal(Number(t.buy_count), 1);
  assert.equal(t.insight.version, "facts-v1");
  const s = await summary();
  assert.equal(s.summary.tokens, 1);
  assert.equal(s.summary.averageGain, 50);
  assert.equal(s.wallets[0].buys, 1);
  assert.equal(s.wallets[0].avg_gain, 50);
});
test("more than 1,000 transactions recover across bounded jobs without advancing the cursor early", async () => {
  await pool.query(
    "INSERT INTO cw_wallets(address,cursor) VALUES('wallet','s0')",
  );
  const txs = Array.from({ length: 1201 }, (_, i) =>
    tx("wallet", "mint", `s${1200 - i}`, 1700000000 + 1200 - i),
  );
  globalThis.fetch = async (url) => {
    const before = new URL(String(url)).searchParams.get("before");
    const start = before ? txs.findIndex((t) => t.signature === before) + 1 : 0;
    return Response.json(txs.slice(start, start + 100));
  };
  const first = await syncWallet("wallet");
  assert.equal(first.again, true);
  assert.equal(
    (await pool.query("SELECT cursor FROM cw_wallets")).rows[0].cursor,
    "s0",
  );
  await initialize();
  let jobs = 1;
  while ((await syncWallet("wallet")).again) {
    jobs++;
    assert.ok(jobs < 20);
  }
  assert.equal(
    (await pool.query("SELECT cursor FROM cw_wallets")).rows[0].cursor,
    "s1200",
  );
  assert.equal(
    Number((await pool.query("SELECT count(*) FROM cw_buys")).rows[0].count),
    1200,
  );
});
test("failed providers keep progress, honor retry delays, and jobs survive expired worker leases", async () => {
  await enqueue("wallet", "test", { address: "wallet" });
  const job = await claim("wallet");
  assert.ok(job);
  await pool.query(
    "UPDATE cw_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
    [job.id],
  );
  await recover();
  const recovered = await claim("wallet");
  assert.equal(recovered?.id, job.id);
  assert.notEqual(recovered?.lease_token, job.lease_token);
  await finish(job!);
  assert.equal(
    (await pool.query("SELECT state FROM cw_jobs")).rows[0].state,
    "running",
  );
  await fail(recovered!, new Error("HTTP 429"));
  assert.equal(
    (await pool.query("SELECT state FROM cw_jobs")).rows[0].state,
    "queued",
  );
  globalThis.fetch = async () =>
    new Response("", { status: 429, headers: { "Retry-After": "60" } });
  await assert.rejects(
    request("fixture", "https://example.test"),
    (e: any) => e.retryAfterMs === 60000,
  );
});
test("keyset pagination and search include assets outside the first page; summaries stay global", async () => {
  for (let i = 0; i < 60; i++)
    await pool.query(
      "INSERT INTO cw_tokens(mint,symbol,name,entry_at,detected_at) VALUES($1,$2,$3,now(),now())",
      [`mint${String(i).padStart(3, "0")}`, `SYM${i}`, `Token ${i}`],
    );
  const one = await tokenPage();
  assert.equal(one.tokens.length, 25);
  assert.equal(one.page.hasMore, true);
  const two = await tokenPage({ cursor: one.page.nextCursor! });
  assert.equal(two.tokens.length, 25);
  assert.equal(
    new Set([...one.tokens, ...two.tokens].map((t) => t.mint)).size,
    50,
  );
  const match = await tokenPage({ query: "SYM2" });
  assert.ok(match.tokens.some((t) => t.symbol === "SYM2"));
  assert.equal((await summary()).summary.tokens, 60);
});
test("metadata works without a trading pair and does not overwrite an existing entry", async () => {
  await pool.query(
    "INSERT INTO cw_tokens(mint,entry_price,entry_source,entry_at) VALUES('mint',2,'purchase',now())",
  );
  globalThis.fetch = async (url) =>
    String(url).includes("helius")
      ? Response.json({
          result: {
            content: {
              metadata: {
                name: "Identity",
                symbol: "ID",
                description: "Description",
              },
              links: { image: "https://example.test/image.png" },
            },
            token_info: { decimals: 6, supply: 1000 },
            creators: [{ address: "creator", share: 100 }],
          },
        })
      : Response.json({
          result: {
            value: {
              owner: "TokenProgram",
              data: {
                parsed: {
                  info: {
                    decimals: 6,
                    supply: "1000",
                    mintAuthority: null,
                    freezeAuthority: null,
                  },
                },
              },
            },
          },
        });
  await enrichMetadata("mint");
  const t = await tokenDetail("mint");
  assert.equal(t.name, "Identity");
  assert.equal(t.metadata.identity.decimals, 6);
  assert.equal(t.entry_price, 2);
  assert.equal(t.metadata_source, "helius-das");
});
test("50 wallets are scheduled durably and processed with bounded concurrent requests", async () => {
  let active = 0,
    maxActive = 0;
  globalThis.fetch = async (url) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    const wallet = new URL(String(url)).pathname.split("/")[3];
    return Response.json([tx(wallet, `mint-${wallet}`, `sig-${wallet}`)]);
  };
  for (let i = 0; i < 50; i++) {
    const address = `wallet-${i}`;
    await pool.query("INSERT INTO cw_wallets(address) VALUES($1)", [address]);
    await enqueue("wallet", `wallet:${address}`, { address });
  }
  await relay();
  const stop = consumers(async (job) =>
    job.kind === "wallet" ? await syncWallet(job.payload.address) : {},
  );
  const deadline = Date.now() + 15000;
  while (
    Number((await pool.query("SELECT count(*) FROM cw_buys")).rows[0].count) <
    50
  ) {
    assert.ok(Date.now() < deadline, "50-wallet fixture timed out");
    await relay();
    await new Promise((r) => setTimeout(r, 50));
  }
  await stop();
  assert.ok(maxActive > 1 && maxActive <= 4);
  assert.equal(
    Number((await pool.query("SELECT count(*) FROM cw_buys")).rows[0].count),
    50,
  );
  console.log(`50-wallet fixture: peak request concurrency ${maxActive}`);
});

test("public wallet changes need no password; webhook deliveries require their provider secret and deduplicate", async () => {
  process.env.HELIUS_WEBHOOK_SECRET = "fixture-webhook";
  const { default: app } = await import("../app.ts");
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address() as any,
    base = `http://127.0.0.1:${address.port}`;
  try {
    const wallet = "11111111111111111111111111111111";
    let response = await originalFetch(base + "/api/wallets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: wallet, label: "Public" }),
    });
    assert.equal(response.status, 201);
    response = await originalFetch(base + "/api/auth");
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    await enqueue("maintenance", "maintenance", {});
    await pool.query(
      "UPDATE cw_jobs SET created_at=now()-interval '5 hours',available_at=now()+interval '1 minute' WHERE kind='maintenance'",
    );
    response = await originalFetch(base + "/api/monitoring");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const monitoring = (await response.json()) as { oldestJobSeconds: number };
    assert.ok(monitoring.oldestJobSeconds < 5);
    const body = JSON.stringify([tx(wallet, "mint", "webhook-sig")]);
    response = await originalFetch(base + "/api/webhooks/helius", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.equal(response.status, 401);
    for (let i = 0; i < 2; i++) {
      response = await originalFetch(base + "/api/webhooks/helius", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "fixture-webhook",
        },
        body,
      });
      assert.equal(response.status, 202);
    }
    assert.equal(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM cw_jobs WHERE job_key LIKE 'webhook:%'",
          )
        ).rows[0].count,
      ),
      1,
    );
    response = await originalFetch(base + "/api/wallets/" + wallet, {
      method: "DELETE",
    });
    assert.equal(response.status, 200);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    delete process.env.HELIUS_WEBHOOK_SECRET;
  }
});
test("optional object archive uploads compressed receipts before marking them archived", async () => {
  const uploads: { url: string; payload: any }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      uploads.push({
        url: req.url!,
        payload: JSON.parse(gunzipSync(Buffer.concat(chunks)).toString()),
      });
      res.writeHead(200);
      res.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address() as any;
  process.env.ARCHIVE_BUCKET = "fixture";
  process.env.ARCHIVE_ENDPOINT = `http://127.0.0.1:${address.port}`;
  process.env.ARCHIVE_PATH_STYLE = "true";
  process.env.AWS_ACCESS_KEY_ID = "fixture-only";
  process.env.AWS_SECRET_ACCESS_KEY = "fixture-only";
  try {
    await pool.query(
      "INSERT INTO cw_receipts(signature,payload,received_at) VALUES('archive-sig',$1,now()-interval '2 days')",
      [JSON.stringify({ signature: "archive-sig" })],
    );
    const { archiveReceipts } = await import("../services/archive.ts");
    await archiveReceipts();
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].payload.signature, "archive-sig");
    assert.equal(
      (await pool.query("SELECT archived FROM cw_receipts")).rows[0].archived,
      true,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    for (const key of [
      "ARCHIVE_BUCKET",
      "ARCHIVE_ENDPOINT",
      "ARCHIVE_PATH_STYLE",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ])
      delete process.env[key];
  }
});
