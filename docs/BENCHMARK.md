# Validation — 8 October 2026

Local PostgreSQL 16, synthetic dataset of 10,000,000 token identities and fixed
prices. Approximately 8,044 MB database storage including indexes. No live provider
requests, buy history or realistic full metadata/chart retention in this benchmark.
The environment has substantially more resources than a small Render/Aiven plan.

Twenty measured read repetitions after index creation:

| Read                    |   p50 |   p95 | Maximum |
| ----------------------- | ----: | ----: | ------: |
| Recent 25-token page    |  3 ms |  5 ms |   33 ms |
| Current performers      |  3 ms |  5 ms |    7 ms |
| Peak performers         |  4 ms |  6 ms |    6 ms |
| Selective symbol search | 13 ms | 16 ms |   26 ms |

Uncached global summary: 9 ms, exact total 10,000,000. Query plans confirmed bounded
index reads for recent tokens and leaders. These are local application/database
read timings with warm caches, not end-to-end Internet latency or production SLAs.
Broad searches, concurrent writes and richer metadata can have different costs.

Also verified:

- 23 unit tests: swap/transfer discrimination, provider retry delay, price tiers,
  cursor validation, query-state isolation and bounded database startup retries.
- Integration suites on PostgreSQL and Redis/BullMQ: bounded concurrent ingestion
  for 50 wallets using mocked providers; repeated deliveries; saved cursor recovery
  through 1,200 transactions; fixed entry and sampled peak; global summaries and
  keyset pages; metadata independent of trading pairs.
- Public wallet add/remove without credentials; authenticated provider webhook
  delivery/deduplication; gzip object archival through a local S3-compatible fixture.
- Nine integration tests now include filtered SWAP import and rescan of buy-less wallets.
- Actual PostgreSQL connection exhaustion: four occupied slots on a five-slot test
  role, API readiness succeeds using the final slot, worker retries SQLSTATE 53300,
  then resumes once the simulated old connections drain. Run `node tools/startup-budget.mjs`
  against the loopback development PostgreSQL admin account after building. It creates
  and removes its own temporary database/role; it never connects to production.
- Chromium desktop and 390px mobile: wallet management, pagination, search beyond
  page one, metadata details, peak sorting, no horizontal page overflow or old APIs.

Live Helius quotas, sustained concurrent production ingestion, hosted Redis/S3,
Aiven failover and production ten-million-token pricing were not validated. Storage
of ten million records does not imply simultaneous near-real-time pricing of them.

## Reproduce

Create an empty isolated loopback database named crypsor_benchmark, initialize it
using tracking/store.ts initialize(), then run:

```sh
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/crypsor_benchmark node --experimental-strip-types tools/benchmark.mts
```

The script rejects non-loopback or nonempty databases, disables only that test
fixture's summary trigger while seeding, builds the production indexes and
recalculates summaries. It does not change tracked configuration. Reserve at least
15 GB free disk. The run saved results in /tmp/crypsor-benchmark-result.json.
