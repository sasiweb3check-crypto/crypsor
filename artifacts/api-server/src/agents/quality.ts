/**
 * QUALITY agent — DexScreener vs pump.fun vs GMGN on the same mint.
 * Fills missing vitals, flags >25% disagreement, writes source reads.
 * Free-tier: Dex is batched, Pump is cheap, GMGN is 2 calls × 4 mints.
 * HTTP is parallel; Postgres writes are sequential (Aiven pool max 5).
 */
import { pool } from "../core/db";
import { pairsForMints } from "../sources/dexscreener";
import { pumpVitals, type PumpVitals } from "../sources/pumpfun";
import { qualityIntel, tokenSecurity } from "../sources/gmgn";
import { capBand, mergeSources, type SourceRead } from "../scoring/quality";
import { agentNote } from "./log";

const BATCH = 8;
const GMGN_BUDGET = 4;
const SECURITY_BUDGET = 2;

type Row = {
  id: number;
  mint: string;
  symbol: string | null;
  phase: string | null;
  graduated: boolean;
  last_mc: number | null;
};

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
}

type Gathered = {
  row: Row;
  dexRead: SourceRead;
  pumpRead: SourceRead;
  pumpMs: number;
  pump: PumpVitals | null;
  gmgnRead: SourceRead;
  gmgnMs: number;
  extra: Record<string, unknown>;
  didGmgn: boolean;
  graduated: boolean;
};

export async function qualityTick(): Promise<{ checked: number; filled: number; flags: number }> {
  const due = await pool.query(
    `SELECT id, mint, symbol, phase, graduated, last_mc
     FROM f2_tokens
     WHERE (source = 'wallet_buy' OR wallet_buys > 0)
       AND COALESCE(phase, 'intake') IN ('intake','ward','icu','recovery','revived')
     ORDER BY CASE COALESCE(phase,'intake') WHEN 'icu' THEN 0 WHEN 'intake' THEN 1 ELSE 2 END,
              last_scan_at ASC NULLS FIRST
     LIMIT ${BATCH}`,
  );
  const rows = due.rows as Row[];
  if (!rows.length) return { checked: 0, filled: 0, flags: 0 };

  const dexMap = await pairsForMints(rows.map((r) => r.mint));
  const gmgnTargets = new Set(rows.slice(0, GMGN_BUDGET).map((r) => r.id));
  const secTargets = new Set(
    rows.filter((r) => r.phase === "icu").slice(0, SECURITY_BUDGET).map((r) => r.id),
  );

  // Pump is cheap and parallel-safe. GMGN from datacenter IPs 403s when we
  // fan out — fetch pump together, then GMGN one mint at a time.
  const pumped = await Promise.all(rows.map(async (row) => {
    const pair = dexMap.get(row.mint);
    const graduated = row.graduated || Boolean(pair && pair.dexId && pair.dexId !== "pumpfun");
    const dexRead: SourceRead = {
      source: "dex",
      ok: Boolean(pair),
      mcUsd: pair?.marketCap ?? pair?.fdv ?? null,
      liqUsd: pair?.liquidity?.usd ?? null,
      holders: null,
      top10Pct: null,
    };
    const pumpT = await timed(() => pumpVitals(row.mint));
    const pumpRead: SourceRead = {
      source: "pump",
      ok: Boolean(pumpT.value),
      mcUsd: pumpT.value?.mcUsd ?? null,
      liqUsd: pumpT.value?.liqUsd ?? null,
      holders: null,
      top10Pct: null,
    };
    return { row, dexRead, pumpRead, pumpMs: pumpT.ms, pump: pumpT.value, graduated };
  }));

  const gathered: Gathered[] = [];
  for (const base of pumped) {
    let gmgnRead: SourceRead = {
      source: "gmgn", ok: false, mcUsd: null, liqUsd: null, holders: null, top10Pct: null,
    };
    let gmgnMs = 0;
    let extra: Record<string, unknown> = {};
    const didGmgn = gmgnTargets.has(base.row.id);

    if (didGmgn) {
      const g = await timed(() => qualityIntel(base.row.mint));
      gmgnMs = g.ms;
      if (g.value) {
        gmgnRead = {
          source: "gmgn",
          ok: true,
          mcUsd: null,
          liqUsd: g.value.liqUsd,
          holders: g.value.holderCount,
          top10Pct: g.value.top10Pct,
        };
        extra = {
          creatorHoldPct: g.value.creatorHoldPct,
          botDegenPct: g.value.botDegenPct,
          freshWalletPct: g.value.freshWalletPct,
          bundlerPct: g.value.bundlerPct,
          creatorTokens: g.value.creatorTokens,
        };
      }
    }

    if (!gmgnRead.ok) {
      const cached = await pool.query(
        `SELECT holders, top10_pct FROM f2_scans
         WHERE token_id = $1 AND (holders IS NOT NULL OR top10_pct IS NOT NULL)
         ORDER BY at DESC LIMIT 1`,
        [base.row.id],
      );
      const c = cached.rows[0] as { holders: number | null; top10_pct: number | null } | undefined;
      if (c && (c.holders != null || c.top10_pct != null)) {
        extra = { ...extra, cached: true, stale: true, lastHolders: c.holders, lastTop10: c.top10_pct };
      }
    }

    if (secTargets.has(base.row.id)) {
      const sec = await tokenSecurity(base.row.mint);
      extra = {
        ...extra,
        honeypot: sec.honeypot,
        rugRatio: sec.rugRatio,
        creatorTokens: extra.creatorTokens ?? sec.creatorTokens,
      };
    }

    gathered.push({ ...base, gmgnRead, gmgnMs, extra, didGmgn });
  }

  let filled = 0;
  let flagCount = 0;

  for (const g of gathered) {
    const merged = mergeSources([g.dexRead, g.pumpRead, g.gmgnRead], g.graduated);
    const band = capBand(merged.mcUsd ?? g.row.last_mc);
    const writes: Array<{ read: SourceRead; ms: number; extra?: Record<string, unknown> }> = [
      { read: g.dexRead, ms: 0 },
      { read: g.pumpRead, ms: g.pumpMs, extra: g.pump ? { graduated: g.pump.graduated, athMc: g.pump.athMc } : undefined },
    ];
    if (g.didGmgn || g.gmgnRead.ok) writes.push({ read: g.gmgnRead, ms: g.gmgnMs, extra: g.extra });

    for (const w of writes) {
      await pool.query(
        `INSERT INTO ward_source_reads (token_id, source, ok, mc_usd, liq_usd, holders, top10_pct, latency_ms, extra)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          g.row.id, w.read.source, w.read.ok, w.read.mcUsd, w.read.liqUsd,
          w.read.holders, w.read.top10Pct, w.ms, w.extra ? JSON.stringify(w.extra) : null,
        ],
      );
    }

    const latest = await pool.query(
      `SELECT id, holders, top10_pct, liq_usd, mc_usd
       FROM f2_scans WHERE token_id = $1 ORDER BY at DESC LIMIT 1`,
      [g.row.id],
    );
    const scan = latest.rows[0] as {
      id: number; holders: number | null; top10_pct: number | null; liq_usd: number | null; mc_usd: number | null;
    } | undefined;
    if (scan) {
      const nextHolders = scan.holders ?? merged.holders;
      const nextTop10 = scan.top10_pct ?? merged.top10Pct;
      const nextLiq = scan.liq_usd ?? merged.liqUsd;
      const nextMc = scan.mc_usd ?? merged.mcUsd;
      const didFill = (scan.holders == null && nextHolders != null)
        || (scan.top10_pct == null && nextTop10 != null)
        || (scan.liq_usd == null && nextLiq != null)
        || (scan.mc_usd == null && nextMc != null);
      await pool.query(
        `UPDATE f2_scans SET
           holders = COALESCE(holders, $2),
           top10_pct = COALESCE(top10_pct, $3),
           liq_usd = COALESCE(liq_usd, $4),
           mc_usd = COALESCE(mc_usd, $5),
           quality = $6,
           sources = $7
         WHERE id = $1`,
        [
          scan.id, nextHolders, nextTop10, nextLiq, nextMc, merged.quality,
          JSON.stringify({ used: merged.used, flags: merged.flags }),
        ],
      );
      if (didFill) filled += 1;
    }

    await pool.query(
      `UPDATE f2_tokens SET
         last_quality = $2,
         cap_band = $3,
         last_holders = COALESCE(last_holders, $4),
         last_liq = COALESCE(last_liq, $5),
         last_mc = COALESCE(last_mc, $6),
         graduated = CASE WHEN $7 THEN true ELSE graduated END
       WHERE id = $1`,
      [
        g.row.id, merged.quality, band, merged.holders, merged.liqUsd, merged.mcUsd,
        g.pump?.graduated ?? g.graduated,
      ],
    );

    const ticker = g.row.symbol || g.row.mint.slice(0, 6);
    const disagree = merged.flags.filter((f) => f.endsWith("_disagree"));
    flagCount += merged.flags.length;
    await agentNote(
      "quality",
      disagree.length ? "FLAG" : "CHECK",
      `$${ticker} q${merged.quality} · ${merged.used.mc ?? "—"} MC · ${merged.used.liq ?? "—"} liq · ${merged.used.holders ?? "—"} holders${merged.flags.length ? ` · ${merged.flags.slice(0, 4).join(",")}` : ""}`,
      { tokenId: g.row.id, mint: g.row.mint },
    );
  }

  return { checked: rows.length, filled, flags: flagCount };
}
