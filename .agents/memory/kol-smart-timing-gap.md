---
name: KOL/Smart timing gap in pro-calls
description: Why tokens with KOL/smart wallets sometimes show K0 S0 and miss pro_calls qualification — and the fix.
---

## The gap

1. Token detected → intelligence engine scores immediately → logs entry to `token_intel_log` with `holder_kol_count = 0` (GMGN holder scan hasn't run yet).
2. GMGN data arrives → `tracked_tokens.holder_kol_count` updated to real value.
3. Next intel cycle writes a NEW log entry with correct KOL/smart — but `pro-scanner` picks the **earliest** qualifying log entry per token (`ORDER BY computed_at ASC`). If that earliest entry had kol = 0, the token never enters `pro_calls`.

**Why:** `pro-scanner` INSERT uses `DISTINCT ON (token_id) … ORDER BY token_id, computed_at ASC` — it uses the first qualifying log row. If no early row ever had KOL/smart > 0, the token is permanently excluded until a future row qualifies.

## Fix

`POST /api/caller/kol-smart-sync` — run on demand (or schedule periodically):
1. Updates `token_intel_log` rows with `holder_kol_count = 0` where `tracked_tokens` now has KOL/smart > 0 (backfills the counts + kol_smart_score).
2. Updates `pro_calls.called_kol_count/smart` where they're 0 but tracked_tokens has data.
3. Updates latest `pro_snapshots` kol/smart = 0 entries (fixes `currentKol/currentSmart` in frontend).
4. Re-runs the pro-scanner INSERT to register newly qualifying tokens.

`GET /api/caller/kol-smart-status` — live view of KOL/smart for tokens with intel >= 70, showing live vs log vs pro_calls values.

**Why:** `called_kol_count` feeds `computeProScore → intelCallStrength`; if it stays 0, pro score is depressed and quality label may stay 'below'.

## Pro-score quality label freeze

`pro-snapshots` CASE expression freezes `quality_label` at 'very_good'/'good' — never downgrades. But 'below' CAN upgrade to 'good'/'very_good' on the next snapshot cycle. So after kol-smart-sync backfills `called_kol_count`, wait ~5 min for the next pro-snapshots pass to recompute and upgrade the label.

## Pro-calls stats vs history divergence

`/api/pro/stats` counts by stored `pro_calls.quality_label`; `/api/pro/history` dynamically computes for rows with NULL quality_label. Run kol-smart-sync + wait for snapshot pass to align them.
