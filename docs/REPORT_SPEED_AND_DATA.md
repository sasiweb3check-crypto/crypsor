# Report speed and data-quality changes

The screenshots show a report mixing observations, diagnostics, generic template text and unsupported research areas. This change separates those concerns without deleting historical judgments or inventing missing metadata.

## External reference checks

Retrieved on 24 October 2026 from the official Helius SDK repository:

- https://github.com/helius-labs/helius-sdk/blob/main/src/types/types.ts — GetAssetRequest supports `options.showFungible`; getAssetBatch is available for later batching.
- https://github.com/helius-labs/helius-sdk/blob/main/src/types/das.ts — Content includes `json_uri`, files, metadata and links; files can include `cdn_uri`; fungible token data includes `token_info`.
- https://github.com/helius-labs/helius-sdk/blob/main/README.md — documented DAS read methods.

The raw official files were actually retrieved. Requests to the Helius docs site, DEX Screener documentation/API and Render documentation were blocked by this environment's proxy. No current vendor entitlement, live price or site latency was verified through those blocked requests.

## Measured local regression case

A dedicated loopback PostgreSQL database held synthetic history: 200 duplicate claims, 50 decisions with large observation contexts, and 25 holder snapshots. Both measurements used the real HTTP report handler and five requests. This stresses history growth; it is not an average production report.

| Measurement | Before | After |
| --- | --- | --- |
| Database round trips per report | 9 | 1 |
| Uncompressed JSON response bytes | 1,326,890 | 1,382 |
| Five local HTTP timings, ms | [661, 557, 545, 345, 104] | [104, 23, 19, 18, 11] |

The smaller response is intentional: it includes current facts, the latest decision, latest distinct claims, and bounded snapshots. Audit history is fetched explicitly with `?history=1`; full historical observation contexts remain in that response and in the append-only database. No audit record was erased for this benchmark. These timings exclude production network distance, Render cold starts and real provider requests. Do not present the numbers as a production speed guarantee.

## Changes

- One PostgreSQL statement assembles the initial token report; mint/time indexes support bounded reads.
- Navigation requests only the current page, instead of fetching Radar first. Authenticated in-memory caches keep up to 20 recent pages; entries are reused for 15 seconds, then refreshed while displaying existing data. Mutations invalidate the cache, logout clears it, and hidden tabs stop polling. Source timestamps stay separate from view refresh times.
- Default reports no longer render raw JSON behind closed details. Audit records and exact evidence details render on demand.
- Metadata supports official DAS fungible options, CDN/original image candidates, IPFS/Arweave references and safe image fallback. Cached older DAS responses can repair missing fields without another Helius request.
- Missing publisher image/description can be filled from recorded metadata JSON only on explicit public content gateways. Requests are metered and bounded (5 seconds, 64 KB), do not follow redirects, and do not include provider credentials. Arbitrary URLs, private hosts, custom ports, URL credentials and insecure schemes are rejected. Other publisher hosts remain unsupported rather than silently trusted.
- Optional Jupiter access is a coverage option, not an enrichment failure. Failed source requests remain visible as concise diagnostics. Old diagnostic claims remain available only in audit history.
- New identical evidence claims are deduplicated by content fingerprint. The default report also groups existing duplicate records. Claims retain source record IDs, retrieval times and RPC method/slot context.
- Rule-based assessments summarize actual recorded facts. They are labelled observations, not AI-generated theses. Model hypotheses, when explicitly enabled, remain unverified and separate. Repeated unchanged evidence does not append another decision; historical generic text remains expandable.
- The report presents authority status, supply, decimals and token-account concentration directly. It does not turn revoked authorities into a safety guarantee, token-account samples into unique holder counts, or independent APIs into independent underlying venues.

## Boundaries

A missing image or description can be a genuine publisher/provider gap. No creator affiliation, originality, social validation, actor attribution or guaranteed returns have been established. Raw unsupported swap layouts remain a discovery coverage limitation. Render Free sleeping can still delay first access and pause background work. A continuously responsive deployment requires the planned always-on infrastructure or another explicit hosting choice; no paid service was enabled here.
