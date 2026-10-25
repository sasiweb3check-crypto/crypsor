# Buy and gain tracking

Implemented 25 October 2026. This describes the code, not a confirmation that the hosted Render service is running this revision.

## Why ongoing buys could be missing

- Wallet polling uses a conservative local request allowance. The defaults (500 requests/day, 10,000/month, half allocated to polling) imply approximately 18 minutes for one wallet, scaling with active wallet count. These are application request caps, not verified Helius credit entitlements. Operations shows the computed interval. Mobile settings now let the operator change the daily/monthly local allowance without rebuilding; existing usage is not reset.
- Render Free sleep and `HUNTER_DISABLE_BACKGROUND=true` stop automatic collection. A browser page refresh cannot collect transactions by itself. Operations now reports background configuration and recent worker heartbeat.
- The enhanced parser required `events.swap`. Some supported program transactions lack that field. A durable `parse_transaction` job now fetches finalized `getTransaction` JSON with parsed transfers for Pump, PumpSwap and Jupiter. Only actual payments plus a matching acquired-token balance establish the fallback. Unsupported or ambiguous routes produce a recorded parse gap rather than a fabricated cost.
- Multi-page catch-up previously waited a full polling interval after every page. Successful incomplete pages now immediately requeue; pending cursors remain due regardless of last success time. Failed/incomplete provider decoding does not advance the checkpoint. Wallet scans and parsing take priority over optional research.
- A webhook/manual observation is provider reported until reconciliation. It now queues a wallet scan for confirmation; it does not create a confirmed purchase entry by itself.
- Existing wallets receive one bounded recent-history replay to recover eligible entries from the newest 100 finalized signatures. It preserves an in-progress normal cursor. This is not a complete lifetime wallet backfill.

## Entry and return definitions

Every eligible buy has its own immutable `wallet_purchase` row with wallet, signature, token raw amount/decimals, quote raw amount/decimals, actual entry in quote units, block time, recording time and amount/fee provenance. Both event identity and signature/wallet/mint prevent duplicate purchase rows. Repeated buys remain distinct entries; a card uses the first covered entry, while the token report lists every recorded buy with pagination.

A supported entry needs a single, unambiguous acquired mint and SOL, USDC or USDT payment with exact raw amounts. Multiple quote inputs, incomplete amounts and unsupported layouts leave entry/gains unavailable. Enhanced entries use provider-decoded amounts from a confirmed/finalized signature. RPC fallback entries use parsed transfers inside recognized swap instruction groups, excluding account creation instructions and unrelated top-level tips. Network fees are excluded; protocol transfers within the group are included. The fee scope is retained per purchase. No current quote, assumed stablecoin peg or historical SOL/USD conversion substitutes for an actual purchase.

`gain % = (last collected price in the entry quote currency / actual entry price - 1) * 100`.

`all-time observed peak % = max(0, (highest collected matching-currency price since the buy / actual entry price - 1) * 100)` when at least one quote exists. Without collected quotes both returns remain unavailable. The entry itself supplies the 0% baseline. Quotes, their sources and retrieval times are append-only. A subsequent loss or a provider failure does not erase the observed peak. The last quote is labelled stale after 15 minutes.

“All-time observed” covers collected observations since that covered buy. It is not the token's lifetime ATH, a complete candle high, a current executable quote, or realized wallet PnL. Tracking continues after a wallet sells; return values describe token price performance from the entry. Historical unsampled peaks cannot be recovered from current prices.

## Ongoing free price collection

A dedicated `prices` job runs in Watch Only, Full and Pause Research, and stops in Stop All. It is separate from slow metadata/research work. DEX Screener batches up to 30 purchased mints using `/tokens/v1/solana/{mints}`. The default local batch interval is about 10 minutes, recalculated from public request limits; larger collections rotate across batches. GeckoTerminal fills missing quotes or primary-source failures. Each run limits fallback calls to three to stay inside a job lease, rotating fallback attempts between tokens. All attempts consume the existing atomic provider budgets.

Native SOL prices are accepted from DEX Screener only on explicitly SOL-quoted pairs, where native and quote units agree. USDC/USDT require GeckoTerminal's explicit base-token/quote-token field and exact relationship mint match. USD market prices remain separate. A price of zero, a different mint/network, or a mismatched quote is not used as a valid sample.

The report shows latest price collection errors, quote source/time and per-buy sample count. It does not claim constant streaming, complete candles or guaranteed coverage under provider caps/outages and Render sleep.

## Journal/replay memory

Paper replays use an explicitly selected actual purchase and the collected subsequent matching-currency samples. They are retrospective sample replays, not full candle backtests or forward predictions. Gaps, threshold crossing, price sources, dataset fingerprint, parameters and limitations are preserved. A replay is bounded to the first 5,000 samples with an explicit truncation flag. Historical buys, price samples, saved experiments and decisions reject update/delete mutations.

## Verification

Tests use isolated loopback databases and synthetic provider fixtures; no fixtures enter production. Integration coverage includes successive buys, deduplication, cursor retention on provider failure, a gap exceeding 100 signatures with immediate continuation, recovery of missing enhanced swap layouts, independent price collection, a falling current gain retaining its peak, public-source fallback, preserved replay cursors, private API access and mobile request-limit persistence. Chromium checks include five pages, a loaded image, actual entry/current loss/retained peak, warm navigation and mobile overflow.

Validation completed: 36 unit/edge/web checks, 28 PostgreSQL/API integration checks, a production build including Cloudflare dry-run, and 17 Chromium flow checks across five pages. All passed.

Both Render and public provider live requests were blocked by the execution environment's CONNECT proxy (HTTP 403). Official Pump/PumpSwap program IDs were retrieved from the public repository IDLs at https://github.com/pump-fun/pump-public-docs/tree/main/idl. The adapters are fixture-tested; live provider responses and production worker/DB state have not been verified here.

Render must run a Node Web Service from the same commit:

- Build: `corepack pnpm install --frozen-lockfile && corepack pnpm build:render`
- Start: `corepack pnpm start:api`
- Preserve the database and settings encryption secret. Leave `HUNTER_DISABLE_BACKGROUND` unset or `false` for this combined API/worker deployment.
- After deployment, open Operations: confirm a recent worker heartbeat, configured Helius key, active wallets, the polling interval and remaining usage. Use Scan wallets, then inspect the wallet's last scan/error and the token's actual buys. The one-time replay repairs only recent covered signatures.

Continuous collection while the site sleeps still requires an always-running worker deployment. No paid hosting or paid provider plan was enabled by this change.
