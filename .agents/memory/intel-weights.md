---
name: Intelligence engine weights
description: Current scoring weights for the 5 signal components — must be kept in sync between engine and frontend
---

# Intelligence Engine Weights

Current weights in `artifacts/api-server/src/pipeline/intelligence-engine.ts`:

| Signal         | Weight | Notes                                          |
|----------------|--------|------------------------------------------------|
| MC Growth      | 27%    | Reduced from 30% — noisy for very early tokens |
| Volume         | 25%    |                                                |
| Holder Vel.    | 22%    | Strong leading indicator                       |
| KOL / Smart    | 18%    | Bumped from 15% — high conviction after G4 fix |
| Liquidity      | 8%     |                                                |

**Why:** KOL/Smart bumped from 15%→18% (high-conviction after G4 flow fix restored real signal). MC Growth reduced 30%→27% to fund it. Total always = 100%.

**How to apply:** Any future weight change must keep sum = 1.00. Also update the hardcoded weight strings in the Signal Breakdown table in `artifacts/crypsor/src/pages/token-detail.tsx` (search for `weight: "27%"` etc.).
