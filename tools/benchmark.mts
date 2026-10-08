import { performance } from "node:perf_hooks";
import { pool } from "../artifacts/api-server/src/tracking/store.ts";
import {
  tokenPage,
  summary,
  invalidateSummary,
} from "../artifacts/api-server/src/tracking/queries.ts";
import fs from "node:fs/promises";
if (
  !process.env.DATABASE_URL?.endsWith("/crypsor_benchmark") ||
  !["127.0.0.1", "localhost"].includes(
    new URL(process.env.DATABASE_URL).hostname,
  )
)
  throw Error("Only isolated benchmark database allowed");
if ((await pool.query("SELECT 1 FROM cw_tokens LIMIT 1")).rowCount)
  throw Error("Benchmark database must be empty");
const c = await pool.connect();
await c.query("SET statement_timeout=0");
await c.query("SET maintenance_work_mem='64MB'");
const definitions = (
  await c.query(
    "SELECT indexname,indexdef FROM pg_indexes WHERE tablename='cw_tokens' AND indexname<>'cw_tokens_pkey'",
  )
).rows;
await fs.writeFile(
  "/tmp/crypsor-benchmark-indexes.json",
  JSON.stringify(definitions),
);
for (const index of definitions) await c.query(`DROP INDEX ${index.indexname}`);
await c.query("ALTER TABLE cw_tokens DISABLE TRIGGER cw_token_stats");
const total = Number(process.env.BENCH_TOKENS ?? 10000000),
  chunk = 500000;
let began = performance.now();
for (let first = 1; first <= total; first += chunk) {
  await c.query(
    `INSERT INTO cw_tokens(mint,symbol,name,entry_price,current_price,peak_price,entry_source,entry_at,detected_at,priced_at,price_due_at,metadata_due_at,metadata)
 SELECT 'Bench'||lpad(i::text,32,'0'),'TK'||i::text,'Token '||i::text,1,1+(i%1000)/100.0,2+(i%1000)/100.0,'detection','2026-01-01'::timestamptz,'2026-10-08'::timestamptz-i*interval '1 second','2026-10-08'::timestamptz,'2036-01-01'::timestamptz,'2036-01-01'::timestamptz,'{"identity":{"decimals":9,"supply":"1000000000000000","source":"synthetic-benchmark"}}'::jsonb FROM generate_series($1::bigint,$2::bigint)i`,
    [first, Math.min(total, first + chunk - 1)],
  );
  console.log(
    `Seeded ${Math.min(total, first + chunk - 1).toLocaleString()} tokens (${Math.round((performance.now() - began) / 1000)}s)`,
  );
}
console.log("Building production indexes");
for (const index of definitions) {
  await c.query(index.indexdef);
  console.log("Built", index.indexname);
}
await c.query("ALTER TABLE cw_tokens ENABLE TRIGGER cw_token_stats");
await c.query("UPDATE cw_stats SET tokens=0,priced=0,positive=0,gain_sum=0");
await c.query(
  `INSERT INTO cw_stats(bucket,tokens,priced,positive,gain_sum) SELECT(hashtext(mint)::bigint & 63)::int,count(*),count(gain),count(*) FILTER(WHERE gain>0),COALESCE(sum(gain),0) FROM cw_tokens GROUP BY 1 ON CONFLICT(bucket) DO UPDATE SET tokens=EXCLUDED.tokens,priced=EXCLUDED.priced,positive=EXCLUDED.positive,gain_sum=EXCLUDED.gain_sum`,
);
await c.query("ANALYZE cw_tokens");
c.release();
const results: any = {
  rows: total,
  seedSeconds: Math.round((performance.now() - began) / 1000),
  tests: {},
};
for (const [name, options] of [
  ["recent", {}],
  ["performers", { sort: "gain" }],
  ["search", { query: "TK998899" }],
] as const) {
  const times = [];
  for (let n = 0; n < 15; n++) {
    const start = performance.now();
    const page = await tokenPage(options);
    times.push(performance.now() - start);
    if (page.tokens.length > 25) throw Error("Unbounded page");
  }
  times.sort((a, b) => a - b);
  results.tests[name] = {
    p50Ms: Math.round(times[7]),
    p95Ms: Math.round(times[14]),
  };
}
invalidateSummary();
let start = performance.now();
const s = await summary();
if (s.summary.tokens !== total) throw Error("Incorrect global summary");
results.summaryMs = Math.round(performance.now() - start);
results.databaseSize = (
  await pool.query(
    "SELECT pg_size_pretty(pg_database_size(current_database())) AS size",
  )
).rows[0].size;
results.plan = (
  await pool.query(
    "EXPLAIN(ANALYZE,BUFFERS) SELECT mint FROM cw_tokens ORDER BY detected_at DESC,mint DESC LIMIT 26",
  )
).rows.map((r) => r["QUERY PLAN"]);
await fs.writeFile(
  "/tmp/crypsor-benchmark-result.json",
  JSON.stringify(results, null, 2),
);
console.log(JSON.stringify(results, null, 2));
await pool.end();
