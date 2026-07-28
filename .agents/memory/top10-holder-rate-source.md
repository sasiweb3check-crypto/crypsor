---
name: Top 10 holder rate data source
description: Which API to use for secTop10HolderRate on Solana tokens, and why RugCheck inflates the value
---

# Top 10 Holder Rate Source

**Rule:** Prefer GMGN's `token_holder_stat` response field `stat.top10_holder_rate` as the primary source for `secTop10HolderRate`. Fall back to RugCheck's `topHolders` computation only when GMGN doesn't return the field.

**Why:** RugCheck's `topHolders[].pct` sum includes exchange wallets, locked tokens, and other non-circulating accounts, inflating the figure significantly (e.g., showing 57.3% when GMGN/on-chain shows 26.8%). GMGN's holder stat matches circulating supply more accurately.

**How to apply:** In `artifacts/api-server/src/lib/gmgn-client.ts`, `fetchTokenSecurity` already calls `vas/api/v1/token_holder_stat` — check `stat?.top10_holder_rate` first. GMGN returns this as a fraction (0–1); if > 1, divide by 100. RugCheck `topHolders[].pct` is a percentage (0–100); dividing the sum by 100 gives the fraction.
