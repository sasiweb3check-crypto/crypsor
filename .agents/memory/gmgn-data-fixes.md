---
name: GMGN data-gap fixes
description: Decisions and lessons from the G1/G4/G3 GMGN data-gap fix session.
---

# GMGN Data-Gap Fixes

## G1 — Liquidity null
**Rule:** `token_info.data.liquidity` (from `/api/v1/token_info/sol/{addr}`) is the most reliable liquidity source — covers pre- and post-graduation tokens. Wire it in every holders-refresh pass (already fetched) via `holders-refresh.ts::fetchAndPersistToken`. The PumpFun bonding curve formula (`2 × MC × virtual_token_reserves / 1e15`) is a secondary fallback for tokens GMGN doesn't index.
**Why:** DexScreener misses many tokens; GMGN token_info fills the gap from a fetch already in the pipeline.
**How to apply:** After every successful holders fetch, extract `tokenInfoRes.data.data.liquidity` and write to `tracked_tokens.liquidityUsd`. Already implemented.

## G4 — Holder momentum always ≤ 0
**Rule:** GMGN's `top_buyers` endpoint is retired (returns 404). When `hold+boughtMore+soldPart+sold === 0`, synthesise flow from per-wallet `buy_tx_count_cur`/`sell_tx_count_cur` in the holder list.
**Why:** `noActivity=true` was forcing `momentumScore=0` for every token, killing the signal.
**How to apply:** In `holder-intel.ts::buildHolderIntel`, the G4 fallback loop runs before `rawFlowSum` is computed. `rawList` must be declared before the flow section (above the G4 block).

## G3 — Weight rebalancing
**Rule:** After G1+G4 fixes, weights are: MC 30% | Vol 25% | HolderVel 22% | KOL/Smart 15% | Liq 8%.
**Why:** MC growth was noisy for very new tokens; KOL/Smart and HolderVel carry stronger signal when flow data is real.

## GMGN headers — working set
**Rule:** Chrome 128 + `Sec-Fetch-Site: same-site` (no `sec-ch-ua` headers, no `Accept-Encoding`). `defi/quotation/v1` is EVM-only; Solana endpoints are `api/v1/token_info`, `vas/api/v1/token_holders`, `vas/api/v1/token_holder_stat`.
**Why:** Tested Chrome 125 + `same-origin` vs Chrome 128 + `same-site` — both pass Cloudflare equally; the new set matches the user's confirmed working config and is cleaner (no sec-ch-ua fingerprinting headers).

## Pump.fun token addresses
Addresses ending in `pump` often return empty on GMGN endpoints — GMGN may not index all pump.fun tokens. This is a GMGN limitation, not a header issue.
