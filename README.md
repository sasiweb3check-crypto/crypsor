# Crypsor

A lightweight, mobile-friendly Solana wallet-buy dashboard. Follow wallet sources,
see their confirmed swap outputs, and track current and peak gain from a fixed entry.
There are no token scores, quality gates or minimum buy amounts.

## Development

Use Node 22 and pnpm 10. Install with `pnpm install --frozen-lockfile`.
Set `DATABASE_URL` for a local PostgreSQL database, `WALLET_ADMIN_PASSWORD` for
wallet management and optionally `HELIUS_API_KEY` for live ingestion.

- `pnpm run build` — type checks and both builds
- `pnpm test` — swap/transfer classification tests
- `pnpm run start:render` — API, frontend and 30-second poller on PORT (default 3000)
- `pnpm --filter @workspace/crypsor dev` — Vite on 5173, API proxy to 3000

The poller automatically creates only its own `cw_*` tables. It never reads or
modifies the previous application's tables. Run only one service instance.

## Tracking behavior

First sync reads a wallet's latest 100 transactions. Later scans paginate back to
its saved cursor, up to 1,000 transactions per scan. If that limit is reached,
the cursor is retained and an error is shown rather than silently skipping buys.

A successful SWAP must show the wallet paying and receiving the token in the
parsed swap event. Without events, a conservative fallback requires a single
incoming token and a matching quote/native payment to that counterparty.
Unattributed or ambiguous transactions are excluded; unsupported parser output
may therefore miss a buy. Transfers, airdrops, rent-only receipts and failed swaps
are not buys. SOL, wrapped SOL and USD stablecoins are treated as settlement assets.

The first detected buy fixes a token's entry. Stablecoin-paid buys use the paid
quote amount per token (USD assumes the stablecoin's peg). Other buys use the first
available DexScreener USD price, explicitly marked "At detection". Missing prices
stay unknown; the token remains visible. Every 30 seconds, up to 300 least-recently
checked tokens get price updates from their most liquid available Solana pair.
Peak gain is the highest sampled price since tracking, not the token's lifetime
all-time high. Current and peak gains are price changes, not realized wallet PnL.
Removing a wallet stops future scans and retains historical discoveries.

## Render

Use the existing Node Web Service and `render.yaml`. Required settings:
`AIVEN_DATABASE_URL`, `HELIUS_API_KEY`, `WALLET_ADMIN_PASSWORD` and `SESSION_SECRET`.
The dashboard is public/read-only; adding/removing wallets and manual scans require
an HttpOnly, same-site admin session. Set the management password securely in Render.
If Aiven uses a private CA, add its PEM certificate as `AIVEN_CA_CERT`. TLS verification
remains enabled. Health endpoint: `/api/healthz`.

The only application APIs are `/api/dashboard`, `/api/wallets`, `/api/auth`,
`/api/sync`, `/api/healthz` and `/api/keepalive`. Old Settings, Ward and scoring APIs
and their clients have been removed. No dummy data is shipped.
