# Crypsor — Pro Intel: Complete Reference
> Everything from token detection → intelligence scoring → Pro Intel entry → display → alerts.
> Generated from live source — July 2026.

---

## Table of Contents
1. [What Is Pro Intel](#1-what-is-pro-intel)
2. [End-to-End Flow](#2-end-to-end-flow)
3. [Service Timing Map](#3-service-timing-map)
4. [Stage 1 — Token Detection & Ingestion](#4-stage-1--token-detection--ingestion)
5. [Stage 2 — Intelligence Engine (Score Gate)](#5-stage-2--intelligence-engine-score-gate)
6. [Stage 3 — Pro Scanner (Pro Intel Entry)](#6-stage-3--pro-scanner-pro-intel-entry)
7. [Stage 4 — Pro Snapshots (Quality Label + ATH)](#7-stage-4--pro-snapshots-quality-label--ath)
8. [Stage 5 — Pro Scoring (0–100)](#8-stage-5--pro-scoring-0100)
9. [Stage 6 — Caller Alerts (Telegram)](#9-stage-6--caller-alerts-telegram)
10. [Database Schema](#10-database-schema)
11. [API Routes](#11-api-routes)
12. [Frontend (caller.tsx)](#12-frontend-callertsx)
13. [Known Issue: Surfaced MC vs Called MC](#13-known-issue-surfaced-mc-vs-called-mc)
14. [Full Source — All Files](#14-full-source--all-files)

---

## 1. What Is Pro Intel

Pro Intel is the filtered high-conviction view inside Crypsor. It shows only tokens that have:
- Been detected via a tracked wallet buy
- Crossed a minimum Intelligence Score of **≥ 80** (gate into `pro_calls`)
- Have at least **1 KOL or Smart wallet** holder
- Were detected at **MC ≥ $5,000**
- AND have a current Pro Score **≥ 55** (`good`) or **≥ 75** (`very_good`)

It lives at the `/` Pro Intel tab in the frontend (`caller.tsx`), backed by `GET /api/pro/history`.

---

## 2. End-to-End Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│  STAGE 1 — DETECTION                                                    │
│                                                                         │
│  Scheduler (30s) → WalletScanner → Helius RPC                          │
│    Detects a buy by a tracked wallet                                    │
│    → Inserts row in tracked_tokens (status = 'new')                    │
│    → Emits token:bought on EventEmitter bus                             │
│    → Triggers HoldersRefresh (12s delay) → GMGN API                    │
│      Fills holder_kol_count, holder_smart_count                        │
└────────────────────────────┬────────────────────────────────────────────┘
                             │ ~0–60s after detection
┌────────────────────────────▼────────────────────────────────────────────┐
│  STAGE 2 — INTELLIGENCE ENGINE  (every 5 min)                          │
│                                                                         │
│  Reads all tracked_tokens + price/holder snapshots + wallet buys        │
│  Computes intelligence_score (0–100) per token:                        │
│    MC Growth     27%                                                    │
│    Volume        25%                                                    │
│    Holder Vel    22%                                                    │
│    KOL/Smart     18%                                                    │
│    Liquidity      8%                                                    │
│  Writes score back to tracked_tokens                                    │
│  Appends row to token_intel_log (only on first pass or ≥1pt change)    │
└────────────────────────────┬────────────────────────────────────────────┘
                             │ ~5–10 min after detection
┌────────────────────────────▼────────────────────────────────────────────┐
│  STAGE 3 — PRO SCANNER  (every 5 min, +20s startup)                   │
│                                                                         │
│  Backfills KOL/smart counts in token_intel_log where kol=0             │
│  Then INSERTs into pro_calls for tokens where:                         │
│    intelligence_score >= 80                                             │
│    holder_kol_count >= 1 OR holder_smart_count >= 1                    │
│    market_cap_usd >= $5,000                                             │
│    status IN ('new','active','watch')                                   │
│  Picks the EARLIEST qualifying log row per token                       │
│  One row per token — ON CONFLICT DO NOTHING                            │
└────────────────────────────┬────────────────────────────────────────────┘
                             │ row in pro_calls, quality_label = NULL
┌────────────────────────────▼────────────────────────────────────────────┐
│  STAGE 4 — PRO SNAPSHOTS  (every 5 min, +40s startup)                 │
│                                                                         │
│  For every row in pro_calls:                                           │
│    Computes Pro Score (0–100) from current market state                │
│    Derives quality_label: very_good / good / below                     │
│    Updates ath_multiple (running max)                                   │
│    Sets milestone flags (hit_2x, hit_3x, hit_5x, hit_10x, hit_100x)  │
│    Sets surfaced_at + surfaced_mc_usd ONCE on first below→good/vg     │
│    Inserts row in pro_snapshots                                         │
│                                                                         │
│  ┌─── quality_label upgrade rules ────────────────────────────────┐   │
│  │  very_good → always stays very_good                             │   │
│  │  good      → upgrades to very_good if score ≥ 75               │   │
│  │  good      → never downgrades                                   │   │
│  │  below/NULL→ gets freshly computed label (can be below still)   │   │
│  └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────────────────┘
                             │ quality_label = 'good' or 'very_good'
                             │ → NOW VISIBLE IN PRO INTEL
┌────────────────────────────▼────────────────────────────────────────────┐
│  STAGE 5 — CALLER ALERTS  (every 5 min, +35s startup)                 │
│                                                                         │
│  Queries: SELECT FROM pro_calls WHERE quality_label IN ('very_good','good')│
│                                                                         │
│  Alert 1 — New Call (very_good only, fires ONCE per token):            │
│    Condition: lastAlertedLabel IS NULL AND quality_label = 'very_good' │
│    Action: Telegram message, sets lastAlertedLabel = '__NEW_CALL__'    │
│                                                                         │
│  Alert 2 — Good Token Sentinel (no Telegram, fires ONCE per token):   │
│    Condition: lastAlertedLabel IS NULL AND quality_label = 'good'      │
│    Action: sets lastAlertedLabel = '__NEW_CALL__' silently             │
│                                                                         │
│  Alert 3 — Milestones (very_good + good, fires once per tier):        │
│    Tiers: 2× 5× 10×                                                    │
│    Persisted in: athAlertMultiple on tracked_tokens                    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Service Timing Map

```
Time after token detection
────────────────────────────────────────────────────────────────────
0s         Token detected (wallet buy via Helius)
           → tracked_tokens INSERT (status = 'new')
           → EventEmitter: token:bought

~12s       Holders discovery fires (12s after token:bought)
           → GMGN API: fills holder_kol_count, holder_smart_count
           ⚠️ If GMGN is slow/proxied, this can take up to 60s

~5 min     Intelligence Engine first pass
           → Scores token, writes to tracked_tokens
           → Appends to token_intel_log
           ⚠️ If GMGN data not yet arrived: kol_count = 0 in log

~5 min     Pro Scanner (20s after intel engine startup)
           → Backfills kol/smart in log where kol=0
           → Attempts INSERT into pro_calls
           ⚠️ If intel_score < 80 or kol still 0: token NOT registered

~10 min    Pro Snapshots (40s after scanner)
           → First snapshot: computes Pro Score + quality_label
           → If quality_label = 'good'/'very_good': token IS visible in Pro Intel
           → surfaced_at + surfaced_mc_usd set here (ONCE)

~10 min    Caller Alerts (35s after snapshots)
           → New Call telegram fired (very_good only)
           → Milestone check

────────────────────────────────────────────────────────────────────
Recurring intervals:
  Intelligence Engine   5 min (no overlap — next starts after prev finishes)
  Pro Scanner          5 min (+20s startup)
  Pro Snapshots        5 min (+40s startup)
  Caller Alerts        5 min (+35s startup)
  Holders Refresh       60s cycle; per-token cooldown 5 min
  Scan loop (Helius)   120s
```

---

## 4. Stage 1 — Token Detection & Ingestion

**Files:** `src/lib/monitor.ts`, `src/lib/holdersRefresh.ts`

### What triggers it
- Scan loop runs every **120s** (5s initial delay)
- Pulls due wallets from the Scheduler queue
- Calls Helius Enhanced Transaction API for new buys
- Any buy from a tracked wallet → token ingested

### tracked_tokens row created
```
status         = 'new'
firstDetectedAt = NOW()
address, chain, name, symbol (from metadata service)
marketCapUsd   (from price service, ~20s cycle)
holderCount, holderKolCount, holderSmartCount  ← initially 0
```

### Holders Discovery (12s after token:bought)
- HoldersRefresh service listens for `token:bought`
- Fires GMGN holders API 12s after detection
- Fills: `holderCount`, `holderKolCount`, `holderSmartCount`, `holderTop10Pct`
- Per-token cooldown: **5 minutes**
- Cycle refresh: every **60s**

---

## 5. Stage 2 — Intelligence Engine (Score Gate)

**File:** `src/pipeline/intelligence-engine.ts`
**Interval:** every 5 min (no overlap)
**Startup:** at boot (no delay)

### Weights
```
MC Growth      27%  (WEIGHTS.mcGrowth  = 0.27)
Volume         25%  (WEIGHTS.volume    = 0.25)
Holder Vel     22%  (WEIGHTS.holderVel = 0.22)
KOL/Smart      18%  (WEIGHTS.kolSmart  = 0.18)
Liquidity       8%  (WEIGHTS.liquidity = 0.08)
```

### Component 1 — MC Growth Score (0–100)
Compares currentMc to a 1–2hr old snapshot:
```
growthPct >= 100%  → 100
growthPct >= 50%   → 85 + scale
growthPct >= 20%   → 65 + scale
growthPct >= 5%    → 50 + scale
growthPct >= -5%   → 40 + scale
growthPct >= -20%  → 20 + scale
growthPct >= -50%  → 5 + scale
else               → 5

Drawdown guard: if peaked and now >70% below peak → forced 5
                if peaked and >50% below peak → forced 15
```

### Component 2 — Volume Intensity Score (0–100)
Percentile of token's 24h volume vs age-cohort peers:
```
Age cohorts: new (<2h), young (<24h), mature (≥24h)
Percentile ≥ 90% → 100
Percentile ≥ 70% → 75 + scale to 100
Percentile ≥ 50% → 55 + scale
Percentile ≥ 30% → 35 + scale
else             → 15 + scale
```

### Component 3 — Holder Velocity Score (0–100)
New holders/hour from last 2 holder snapshots:
```
velocityPerHour vs cohort percentile → 10 + (rank/total)*90

Absolute fallback (no cohort data):
  ≥100/hr → 100
  ≥ 50/hr → 80
  ≥ 20/hr → 60
  ≥  5/hr → 40
  >  0/hr → 25
  else    → 10
```

### Component 4 — KOL/Smart Score (0–100)
Takes the **MAX** of two sources:

**Source A — GMGN holder classification:**
```
gmgnScore = (kolCount/total)*100*2.5 + (smartCount/total)*100*2.0
```

**Source B — tracked wallet buys:**
```
trackedScore = min(100, distinctTrackedWallets * 25)
(1 wallet = 25, 2 = 50, 3 = 75, 4+ = 100)
```

Source B is the fallback when GMGN data hasn't arrived yet.

### Component 5 — Liquidity Health Score (0–100)
```
liq >= $500K  → 95
liq >= $100K  → 80+
liq >= $50K   → 65+
liq >= $20K   → 50+
liq >= $10K   → 35+
else          → 20+

Stability bonus: +8 if liq grew >10% recently
Stability penalty: -15 if liq dropped >20%; -25 if >40%
lowLiquidityFlag OR liq < $5K → forced 10
```

### Age Multiplier
Applied to the raw weighted sum BEFORE bonuses/penalties:
```
age < 2h  → ×1.30  (fresh momentum boost)
age < 7h  → ×1.00
age < 24h → ×0.97
age < 48h → ×0.92
age ≥ 48h → ×0.82
```

### Risk Penalties (applied after age multiplier)
```
holderTop10Pct > 78% → -28 pts
holderTop10Pct > 68% → -18 pts
holderTop10Pct > 58% →  -8 pts
marketCap < $5,000   → -10 pts
drawdown > 60% from peak → -6 to -12 pts (softened for high-entry-gain tokens)
drawdown > 40% from peak → -5 pts
```

### Bonuses
```
holderCount > 75     → +9 pts
kolSmartScore > 85   → +6 pts
volume > 90 AND mc growth > 85 → +7 pts
```

### Quality Label (from intelligence score — used for UI labeling only)
```
≥ 82  → Elite
≥ 72  → Excellent
≥ 62  → Strong
≥ 52  → Good
≥ 40  → Average
≥ 25  → Speculative
< 25  → Weak
```
⚠️ This is DIFFERENT from the Pro Score quality label. The intelligence quality label is for display in the main dashboard. The Pro Score quality label (`very_good`/`good`/`below`) gates Pro Intel visibility.

### Token Graduation ('new' → 'active')
```
Requires 3 CONSECUTIVE intelligence cycles where:
  intelligenceScore >= 55
  AND ≥ 3 sub-scores above 40

On graduation: status = 'active', emits price:updated event
```

### token_intel_log
A row is appended when:
- First time scoring a token
- Score changes ≥ 1.0 pts
- Status changes

Key fields logged:
```
token_id, computed_at, intelligence_score, prev_intelligence_score
mc_growth_score, volume_intensity_score, holder_velocity_score
kol_smart_score, liquidity_health_score
age_multiplier, token_age_hours
market_cap_usd, holder_kol_count, holder_smart_count
status_before, status_after
```

---

## 6. Stage 3 — Pro Scanner (Pro Intel Entry)

**File:** `src/pipeline/pro-scanner.ts`
**Interval:** 5 min (+20s startup delay)

### Step 0 — KOL/Smart Backfill (runs before every scan)
```sql
UPDATE token_intel_log l
SET
  holder_kol_count   = t.holder_kol_count,
  holder_smart_count = t.holder_smart_count,
  kol_smart_score    = LEAST(100, GREATEST(0,
    (t.holder_kol_count::float / NULLIF(t.holder_count,0)) * 250.0 +
    (t.holder_smart_count::float / NULLIF(t.holder_count,0)) * 200.0
  ))
FROM tracked_tokens t
WHERE l.token_id = t.id
  AND (l.holder_kol_count IS NULL OR l.holder_kol_count = 0)
  AND (l.holder_smart_count IS NULL OR l.holder_smart_count = 0)
  AND (t.holder_kol_count >= 1 OR t.holder_smart_count >= 1)
  AND l.intelligence_score >= 80
```
⚠️ Limitation: only patches rows where `intelligence_score >= 80`. If the first log entry scored < 80 because kol=0 dragged the intel score down (KOL = 18% weight), the backfill skips it. The token will only qualify once a LATER log entry has score ≥ 80.

### Step 1 — INSERT into pro_calls
```sql
INSERT INTO pro_calls (
  token_id, called_at, called_mc_usd, called_intel_score,
  called_kol_count, called_smart_count, called_kol_smart_score
)
SELECT DISTINCT ON (l.token_id)
  l.token_id,
  l.computed_at       AS called_at,
  l.market_cap_usd    AS called_mc_usd,
  l.intelligence_score AS called_intel_score,
  l.holder_kol_count,
  l.holder_smart_count,
  l.kol_smart_score
FROM token_intel_log l
WHERE l.intelligence_score >= 80
  AND (l.holder_kol_count >= 1 OR l.holder_smart_count >= 1)
  AND l.market_cap_usd::numeric >= 5000
  AND l.status_after IN ('new', 'active', 'watch')
  AND NOT EXISTS (SELECT 1 FROM pro_calls pc WHERE pc.token_id = l.token_id)
ORDER BY l.token_id, l.computed_at ASC   ← picks EARLIEST qualifying row
ON CONFLICT (token_id) DO NOTHING
```

### Result
- One `pro_calls` row per token — never duplicated
- `called_mc_usd` = MC at the earliest qualifying intel log entry
- `quality_label` starts as NULL — token is NOT yet visible in Pro Intel

---

## 7. Stage 4 — Pro Snapshots (Quality Label + ATH)

**File:** `src/pipeline/pro-snapshots.ts`
**Interval:** 5 min (+40s startup delay)

### What it does every cycle
For every row in `pro_calls` joined with `tracked_tokens`:
1. Computes new ATH multiple: `max(prev_ath, current_mc/called_mc, pipeline_ath_mc/called_mc)`
2. Computes Pro Score + quality_label via `computeProScore()` (see Stage 5)
3. Updates milestone flags (`hit_2x`, `hit_3x`, `hit_5x`, `hit_10x`, `hit_100x`) — set once, never cleared
4. Updates `quality_label` using one-way ratchet rules (see below)
5. Sets `surfaced_at` / `surfaced_mc_usd` on first transition out of `below`
6. Inserts a row in `pro_snapshots`

### quality_label ratchet (UPDATE statement)
```sql
quality_label = CASE
  WHEN quality_label = 'very_good'                              THEN 'very_good'
  WHEN quality_label = 'good' AND $newLabel = 'very_good'       THEN 'very_good'
  WHEN quality_label = 'good'                                   THEN 'good'
  ELSE $newLabel   -- NULL or 'below' → gets fresh label (can be below/good/very_good)
END
```
Rules in plain English:
- `very_good` **never downgrades**
- `good` can only **upgrade** to `very_good`, never downgrade
- `below` / `NULL` gets the freshly computed label each cycle

### surfaced_at / surfaced_mc_usd (NEW — fixes entry price bug)
```sql
surfaced_at     = COALESCE(surfaced_at,     NOW())
surfaced_mc_usd = COALESCE(surfaced_mc_usd, $current_mc)
```
Set only when `qualityLabel IN ('good', 'very_good')`.
Uses `COALESCE` so it's write-once — subsequent snapshots don't overwrite it.

---

## 8. Stage 5 — Pro Scoring (0–100)

**File:** `src/lib/pro-scoring.ts`

### Weights
```
Intel/Call Strength   25%  (calledIntelScore + KOL/Smart bonus)
MC & Liquidity        20%  (called MC log-scale + liquidity)
ATH Multiplier        20%  (log-scale 1× → 20×)
Gain Momentum         15%  (current gain % since call)
Run Status Quality    10%  (PUMPING/RAN/SLOW/FLAT/DEAD)
Risk / Security       10%  (honeypot, renounced, top-10, LP lock)
```

### Component 1 — Intel/Call Strength (0–100)
```
base = min(100, calledIntelScore ?? 60)
bonus:
  (kol + smart) >= 5  → +15
  (kol + smart) >= 3  → +10
  (kol + smart) >= 2  → +6
  (kol + smart) >= 1  → +3
  else                → 0
result = min(100, base + bonus)
```

### Component 2 — MC & Liquidity (0–100)
```
MC log-scale: $5K=0, $50K=50, $1M=100
  mcScore = (log10(mc) - log10(5000)) / (log10(1000000) - log10(5000)) * 100

Liquidity log-scale: $0=0, $10K=50, $100K=100
  liqScore = log10(liq+1) / log10(100001) * 100

combined = mcScore * 0.6 + liqScore * 0.4
```

### Component 3 — ATH Multiplier (0–100)
```
x >= 20× → 100
else: (log2(x) / log2(20)) * 100

Key values:
  1×  →   0
  2×  →  23
  5×  →  54
  10× →  77
  20× → 100
```
⚠️ At call time (x=1×) this is **0** — the biggest source of the "below at call time" issue.

### Component 4 — Gain Momentum (0–100)
```
gain >= 500% → 100
gain >= 200% → 85 + scale
gain >= 100% → 70 + scale
gain >= 50%  → 55 + scale
gain >= 0%   → 30 + scale
negative     → max(0, 30 + gain/50 * 15)

Key: at call time gain = 0% → score = 30
```

### Component 5 — Run Status (0–100)
```
PUMPING → 100  (ratio >= 1.1 AND current >= ath*0.70)
RAN     →  75  (ath >= 2× AND current < ath*0.50)
SLOW    →  45  (ratio between 0.70–1.30)
FLAT    →  25  (otherwise)
DEAD    →   0  (current MC < $5K)
```

### Component 6 — Risk/Security (0–100)
```
secIsHoneypot = true → 0 (instant fail)
no security data yet → 50 (neutral baseline)

Base: 50
+12 if secMintRenounced
+12 if secFreezeRenounced
+14 if secTop10HolderRate < 25%
+7  if secTop10HolderRate < 40%
+12 if secLpLocked
-15 if secRatTraderAmtRate > 30%
```

### Quality Labels (Pro Score thresholds)
```
very_good  ≥ 75   → shown in Pro Intel, triggers New Call Telegram alert
good       ≥ 55   → shown in Pro Intel (no Telegram alert, sentinel only)
below      < 55   → NOT visible in Pro Intel
```

### Pro Score at call time (example — why tokens start as 'below')
For a typical token called at 73K MC, ATH=1×, gain=0%, FLAT runStatus:
```
intelCallStrength: 88 × 0.25 = 22.0
mcAndLiquidity:    50 × 0.20 = 10.0
athMultiplier:      0 × 0.20 =  0.0   ← zero at call time
gainMomentum:      30 × 0.15 =  4.5   ← 30 at 0% gain
runStatusQuality:  25 × 0.10 =  2.5   ← FLAT = 25
riskQuality:       50 × 0.10 =  5.0
────────────────────────────────────
Total:                         44.0   → "below" (< 55)
```

The token is in `pro_calls` but **invisible in Pro Intel** until ATH/gain push score ≥ 55.

### deriveRunStatus logic
```
currentMc < $5K                           → DEAD
calledMc = 0                              → FLAT
ratio >= 1.1 AND current >= ath*0.70      → PUMPING
ath >= 2.0  AND current < ath*0.50        → RAN
ath >= 1.3  AND current < ath*0.60        → RAN
ratio between 0.70–1.30                   → SLOW
else                                      → FLAT
```

---

## 9. Stage 6 — Caller Alerts (Telegram)

**File:** `src/pipeline/caller-alerts.ts`
**Interval:** 5 min (+35s startup)

### Query
```sql
SELECT FROM pro_calls pc
JOIN tracked_tokens t ON t.id = pc.token_id
WHERE pc.quality_label IN ('very_good', 'good')
```

### Alert 1 — New Call (very_good only)
```
Condition:  lastAlertedLabel IS NULL AND qualityLabel = 'very_good'
Action:     Send Telegram message
            Set lastAlertedLabel = '__NEW_CALL__'
            Set lastAlertedAt = NOW()
Fires:      EXACTLY ONCE per token, ever
Skips:      milestone check this cycle (handled next cycle)
```

Telegram message includes:
- Token name/symbol, score, KOL count, smart count
- Called MC
- GMGN link + social links

### Alert 2 — Good Sentinel (no Telegram)
```
Condition:  lastAlertedLabel IS NULL AND qualityLabel = 'good'
Action:     Set lastAlertedLabel = '__NEW_CALL__' silently
            (prevents repeated evaluation; still processes milestones)
Fires:      ONCE per token
```

### Alert 3 — Milestones (very_good + good)
```
Tiers:      2×, 5×, 10× (no 3×)
Condition:  athMultiple >= tier AND tier > athAlertMultiple
Action:     Send Telegram message
            Set athAlertMultiple = tier on tracked_tokens
Fires:      ONCE per tier, ever
```

Telegram message includes: token name, tier emoji (🔥/🚀/💎), called MC, estimated ATH MC, intel score, KOL count.

---

## 10. Database Schema

### pro_calls
```sql
CREATE TABLE pro_calls (
  id                    SERIAL PRIMARY KEY,

  -- Token reference
  token_id              INTEGER NOT NULL UNIQUE,  -- FK → tracked_tokens.id

  -- Snapshot of conditions at first qualification (set by pro-scanner)
  called_at             TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  called_mc_usd         TEXT,          -- MC at earliest qualifying intel log entry
  called_intel_score    REAL,
  called_kol_count      INTEGER DEFAULT 0,
  called_smart_count    INTEGER DEFAULT 0,
  called_kol_smart_score REAL,

  -- Running ATH tracker (updated every snapshot cycle)
  ath_multiple          REAL DEFAULT 1,
  last_snapshot_at      TIMESTAMPTZ,

  -- Pro Score + quality label (updated every snapshot cycle)
  pro_score             REAL,
  quality_label         TEXT,          -- 'very_good' | 'good' | 'below'

  -- Surfaced tracking (NEW — set once, never overwritten)
  -- When quality_label FIRST transitioned out of 'below'/NULL to 'good'/'very_good'
  -- This is the true "entry" price users actually saw the token at
  surfaced_at           TIMESTAMPTZ,
  surfaced_mc_usd       TEXT,

  -- Milestone flags (set once, never cleared)
  hit_2x                BOOLEAN DEFAULT FALSE,
  hit_2x_at             TIMESTAMPTZ,
  hit_3x                BOOLEAN DEFAULT FALSE,
  hit_3x_at             TIMESTAMPTZ,
  hit_5x                BOOLEAN DEFAULT FALSE,
  hit_5x_at             TIMESTAMPTZ,
  hit_10x               BOOLEAN DEFAULT FALSE,
  hit_10x_at            TIMESTAMPTZ,
  hit_100x              BOOLEAN DEFAULT FALSE,
  hit_100x_at           TIMESTAMPTZ,

  created_at            TIMESTAMPTZ DEFAULT NOW()
);
```

### pro_snapshots
```sql
CREATE TABLE pro_snapshots (
  id            SERIAL PRIMARY KEY,

  pro_call_id   INTEGER NOT NULL,   -- FK → pro_calls.id
  token_id      INTEGER NOT NULL,   -- FK → tracked_tokens.id

  snapshot_at   TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Market state at snapshot time
  mc_usd        TEXT,
  kol_count     INTEGER DEFAULT 0,
  smart_count   INTEGER DEFAULT 0,
  intel_score   REAL,

  -- ATH multiple at this snapshot (current_mc / called_mc)
  ath_multiple  REAL
);
```

### token_intel_log (key fields relevant to Pro Intel)
```sql
token_id              INTEGER
computed_at           TIMESTAMPTZ
intelligence_score    REAL
market_cap_usd        TEXT
holder_kol_count      INTEGER   -- 0 if GMGN data not yet arrived
holder_smart_count    INTEGER
kol_smart_score       REAL
status_after          TEXT      -- 'new' | 'active' | 'watch' | 'archive'
```

### tracked_tokens (key fields for Pro Intel)
```sql
intelligence_score    REAL      -- latest computed by intelligence engine
holder_kol_count      INTEGER   -- from GMGN
holder_smart_count    INTEGER
holder_count          INTEGER
last_alerted_label    TEXT      -- '__NEW_CALL__' once alerted
ath_alert_multiple    REAL      -- last milestone tier alerted (2/5/10)
```

---

## 11. API Routes

**File:** `src/routes/pro.ts`

### GET /api/pro/stats
Returns aggregate performance across quality tokens:
```json
{
  "total": 64,
  "totalAllTime": 120,
  "winRate": 73,
  "x1Count": 50, "x2Count": 36, "x3Count": 24,
  "x5Count": 19, "x10Count": 2, "x100Count": 0,
  "bestAth": 300.9,
  "veryGoodCount": 15, "goodCount": 49,
  "qualityCount": 64,
  "recentCount": 10
}
```
Note: `win` = `ath_multiple >= 2`. Stats use `called_mc_usd` as denominator.

### GET /api/pro/history?sort=&order=&quality=
Quality filter options: `quality` (default, vg+good), `very_good`, `good`, `all`, `recent`
Sort keys: `proScore` (default), `calledAt`, `ath`, `gain`, `intel`, `calledMc`

Returns per-token:
```json
{
  "id": 42,
  "address": "...",
  "calledAt": "2026-07-28T10:00:00Z",
  "calledMcUsd": 73000,
  "calledIntel": 85,
  "calledKol": 1,
  "calledSmart": 0,
  "currentMcUsd": 432000,
  "gainSinceCall": 492,
  "athMultiple": 190.8,
  "runStatus": "RAN",
  "proScore": 86,
  "qualityLabel": "very_good",
  "surfacedAt": "2026-07-29T14:30:00Z",    ← when it appeared in Pro Intel
  "surfacedMcUsd": 146000,                  ← actual entry price shown to users
  "hit2x": true, "hit2xAt": "...",
  "hit5x": true, "hit5xAt": "...",
  "hit10x": false,
  "secMintRenounced": true,
  "secFreezeRenounced": true,
  "secIsHoneypot": false,
  "socials": { "twitter": "...", "telegram": "..." }
}
```

### GET /api/pro/token/:tokenId
Single token's pro call record with milestone data. Used by token detail page.

---

## 12. Frontend (caller.tsx)

**File:** `artifacts/crypsor/src/pages/caller.tsx`

### Quality filter tabs
```
VERY GOOD  → quality_label = 'very_good' (score ≥ 75)
GOOD       → quality_label = 'good' (score 55–74)
ALL QUALITY → very_good + good
RECENTLY ADDED → quality tokens called in last 24h
```

### Stats header chips
Win Rate, Very Good count, Good count, ATH brackets (2×/3×/5×/10×/100×+), Best ATH

### Token row display
```
[logo] [symbol] [RUN_BADGE] [QUALITY_BADGE · score]
       [⚑ surfacedMcUsd → currentMcUsd]  [K{kol}] [S{smart}] [security icon]
                                          ATH {athMultiple}
                                          {gainSinceCall}
                                          Age {calledAt}
```

Entry price logic:
```typescript
// If surfacedMcUsd exists and differs from calledMcUsd → show surfaced MC with ⚑ flag
// Tooltip reveals the original called MC
// If equal or null → show calledMcUsd as normal "MC X → Y"
```

### Run status badges
```
PUMPING  green   current MC near ATH and growing
RAN      blue    already peaked, now retracted
SLOW     amber   slight movement
FLAT     gray    sideways
DEAD     red     MC < $5K
```

### Quality badges
```
⭐ VERY GOOD · {score}   gold gradient
   GOOD · {score}        blue
```

---

## 13. Known Issue: Surfaced MC vs Called MC

### The bug
The Pro Score depends on ATH Multiplier (20%) and Gain Momentum (15%). At call time these are always near zero:
- ATH = 1× → ATH Multiplier score = 0
- Gain = 0% → Gain Momentum score = 30

A typical new token scores ~44 pro points → `below` → **not shown in Pro Intel**.
After gaining 2×+ ATH, the score crosses 55 → `good` → **now visible in Pro Intel**.
But `called_mc_usd` (73K) is displayed as entry — even though no user ever saw this token at 73K.

### The fix (implemented)
1. **`surfaced_at`** + **`surfaced_mc_usd`** columns added to `pro_calls`
2. **pro-snapshots.ts** sets them with `COALESCE` (write-once) the first time quality transitions to `good`/`very_good`
3. **Frontend** shows `surfaced_mc_usd` with a ⚑ flag when it differs from `called_mc_usd`
4. `called_mc_usd` preserved in tooltip — still used for ATH multiple and gain calculations

### Impact on stats
`gainSinceCall` and `athMultiple` in the API still use `called_mc_usd` as denominator. This can inflate numbers (a token "surfaced" at 2× its called price shows more gain than users could actually capture). A future fix would be to add `gainSinceSurfaced` alongside the current `gainSinceCall`.

---

## 14. Full Source — All Files

### src/pipeline/intelligence-engine.ts
```typescript
/**
 * Intelligence Engine
 * Weights: MC 27% | Vol 25% | HolderVel 22% | KOL/Smart 18% | Liq 8%
 * Interval: every 5 min (no overlap)
 */

const WEIGHTS = {
  mcGrowth:   0.27,
  volume:     0.25,
  holderVel:  0.22,
  kolSmart:   0.18,
  liquidity:  0.08,
};

const GRADUATION_SCORE_THRESHOLD = 55;   // intel score to graduate 'new' → 'active'
const GRADUATION_POSITIVE_SIGNALS = 3;   // sub-scores ≥ 40 required
const GRADUATION_CONSECUTIVE = 3;        // consecutive cycles required
const SIGNAL_POSITIVE_FLOOR = 40;
const PRUNE_OLDER_THAN_MS = 48 * 60 * 60 * 1000;  // prune price snapshots >48h
```

*(See full source in `artifacts/api-server/src/pipeline/intelligence-engine.ts`)*

---

### src/pipeline/pro-scanner.ts
```typescript
const MIN_INTEL = 80;    // minimum intelligence_score to qualify
const MIN_MC    = 5_000; // minimum called MC in USD
const SCAN_INTERVAL_MS  = 5 * 60_000;
const STARTUP_DELAY_MS  = 20_000;
```

Backfill → INSERT (earliest qualifying intel log row) → ON CONFLICT DO NOTHING

---

### src/pipeline/pro-snapshots.ts
```typescript
const SNAP_INTERVAL_MS  = 5 * 60_000;
const STARTUP_DELAY_MS  = 40_000;

// Milestone thresholds tracked:
// 2× 3× 5× 10× 100×

// surfaced_at / surfaced_mc_usd set with COALESCE (write-once)
// when qualityLabel transitions to 'good' or 'very_good'
```

---

### src/lib/pro-scoring.ts
```typescript
export const PRO_SCORE_WEIGHTS = {
  intelCallStrength: 0.25,
  mcAndLiquidity:    0.20,
  athMultiplier:     0.20,
  gainMomentum:      0.15,
  runStatusQuality:  0.10,
  riskQuality:       0.10,
};

export const PRO_SCORE_THRESHOLDS = {
  veryGood: 75,
  good:     55,
};

export type QualityLabel = "very_good" | "good" | "below";
export type RunStatus    = "PUMPING" | "RAN" | "SLOW" | "FLAT" | "DEAD";
```

---

### src/pipeline/caller-alerts.ts
```typescript
const CHECK_INTERVAL_MS  = 5 * 60 * 1_000;
const ALERT_MILESTONES   = [2, 5, 10];  // 3× removed (noise)

// New Call: fires once for very_good (Telegram)
// Good Sentinel: fires once for good (silent, no Telegram)
// Milestones: 2×/5×/10× (Telegram for both quality tiers)
```

---

### lib/db/src/schema/pro_calls.ts
Full schema — see Section 10 above.

### lib/db/src/schema/pro_snapshots.ts
Full schema — see Section 10 above.

---

*Document generated from live source — Crypsor v1, July 2026.*
