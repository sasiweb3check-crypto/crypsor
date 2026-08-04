/**
 * GEM engine — records the evidence tape and produces the one trusted call.
 *
 * Hooked into pump-buy-scanner: every Dex scan tick for a buy-sourced token
 *   1. appends a gem_snapshots row (compact market/flow/holder state)
 *   2. recomputes the GEM score from the tape + holder intel + security
 *   3. upserts gem_scores (verdict, confidence, streak, sticky call anchors)
 *   4. fires GEM_CALL / GEM_2X / GEM_5X / GEM_10X alerts (Telegram + in-app)
 *
 * Holder + security inputs come from the existing holders-refresh and
 * security-service pipelines (tracked_tokens.holder_* / sec_* columns) —
 * this engine only reads them and demands freshness via confidence.
 */

import { db, gem_snapshots } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { opsLog } from "../lib/ops-log";
import {
  escTelegram,
  fmtUsdCompact,
  sendTelegramMessage,
} from "../lib/telegram-send";
import {
  computeGemScore,
  type GemInputs,
  type GemResult,
  type GemTapePoint,
} from "../lib/gem-score";
import type { DexPairLike } from "../lib/pump-sdk-score";
import { eventBus } from "./event-bus";
import { healthMonitor } from "./health-monitor";

const log = logger.child({ module: "gem-engine" });

healthMonitor.register("gem-engine");

const SNAPSHOT_MIN_GAP_MS = 40_000;
const TAPE_ROWS = 30;
const HOLDERS_FRESH_MIN = 45;
const PRUNE_EVERY_N = 50;

let evalsSincePrune = 0;

type TokenGemRow = {
  address: string;
  symbol: string | null;
  name: string | null;
  holder_count: number | null;
  holder_top10_pct: number | null;
  holder_sniper_count: number | null;
  holder_bundler_count: number | null;
  holder_smart_count: number | null;
  holder_kol_count: number | null;
  holder_largest_cluster_pct: number | null;
  holder_cabal_detected: boolean | null;
  holders_age_min: number | null;
  sec_is_honeypot: boolean | null;
  sec_mint_renounced: boolean | null;
  sec_freeze_renounced: boolean | null;
  sec_buy_tax: number | null;
  sec_sell_tax: number | null;
  sec_lp_locked: boolean | null;
  sec_top10_holder_rate: number | null;
  sec_fetched: boolean;
  tracked_wallets: number;
  gem_streak: number;
  first_gem_at: Date | string | null;
  gem_call_mc_usd: number | null;
  peak_after_call_mc: number | null;
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function writeGemSnapshot(tokenId: number, pair: DexPairLike, holderCount: number | null): Promise<void> {
  const recent = await db.execute(sql`
    SELECT EXTRACT(EPOCH FROM (NOW() - at)) * 1000 AS age_ms
    FROM gem_snapshots WHERE token_id = ${tokenId}
    ORDER BY at DESC LIMIT 1
  `);
  const ageMs = Number((recent.rows[0] as { age_ms?: number } | undefined)?.age_ms ?? Infinity);
  if (ageMs < SNAPSHOT_MIN_GAP_MS) return;

  await db.insert(gem_snapshots).values({
    tokenId,
    mcUsd: num(pair.marketCap ?? pair.fdv),
    liqUsd: num(pair.liquidity?.usd),
    priceUsd: num(pair.priceUsd),
    vol5m: num(pair.volume?.m5),
    vol1h: num(pair.volume?.h1),
    vol24h: num(pair.volume?.h24),
    buys5m: num(pair.txns?.m5?.buys),
    sells5m: num(pair.txns?.m5?.sells),
    buys1h: num(pair.txns?.h1?.buys),
    sells1h: num(pair.txns?.h1?.sells),
    priceChange5m: num(pair.priceChange?.m5),
    priceChange1h: num(pair.priceChange?.h1),
    holderCount: holderCount != null && holderCount > 0 ? holderCount : null,
  });
}

async function pruneGemSnapshots(): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM gem_snapshots WHERE at < NOW() - INTERVAL '48 hours'`);
    await db.execute(sql`
      DELETE FROM gem_snapshots g WHERE g.id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY token_id ORDER BY at DESC) AS rn
          FROM gem_snapshots
        ) x WHERE x.rn > 200
      )
    `);
  } catch (err) {
    log.warn({ err }, "gem snapshot prune failed");
  }
}

async function loadTokenGemRow(tokenId: number): Promise<TokenGemRow | null> {
  const rows = await db.execute(sql`
    SELECT
      t.address, t.symbol, t.name,
      t.holder_count, t.holder_top10_pct,
      t.holder_sniper_count, t.holder_bundler_count,
      t.holder_smart_count, t.holder_kol_count,
      t.holder_largest_cluster_pct, t.holder_cabal_detected,
      EXTRACT(EPOCH FROM (NOW() - COALESCE(t.holder_momentum_updated_at, t.last_holders_updated_at))) / 60
        AS holders_age_min,
      t.sec_is_honeypot, t.sec_mint_renounced, t.sec_freeze_renounced,
      t.sec_buy_tax, t.sec_sell_tax, t.sec_lp_locked, t.sec_top10_holder_rate,
      (t.sec_fetched_at IS NOT NULL) AS sec_fetched,
      COALESCE(tb.n, 0)::int AS tracked_wallets,
      COALESCE(g.gem_streak, 0)::int AS gem_streak,
      g.first_gem_at, g.gem_call_mc_usd, g.peak_after_call_mc
    FROM tracked_tokens t
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT wallet_id) AS n FROM token_buys WHERE token_id = t.id
    ) tb ON TRUE
    LEFT JOIN gem_scores g ON g.token_id = t.id
    WHERE t.id = ${tokenId}
    LIMIT 1
  `);
  return (rows.rows[0] as TokenGemRow | undefined) ?? null;
}

async function loadTape(tokenId: number): Promise<GemTapePoint[]> {
  const rows = await db.execute(sql`
    SELECT EXTRACT(EPOCH FROM at) * 1000 AS at_ms,
           mc_usd, liq_usd, vol_5m, buys_5m, sells_5m, buys_1h, sells_1h, holder_count
    FROM gem_snapshots
    WHERE token_id = ${tokenId}
    ORDER BY at DESC
    LIMIT ${TAPE_ROWS}
  `);
  return (rows.rows as Array<Record<string, unknown>>)
    .map((r) => ({
      atMs: num(r.at_ms),
      mcUsd: r.mc_usd != null ? num(r.mc_usd) : null,
      liqUsd: r.liq_usd != null ? num(r.liq_usd) : null,
      vol5m: r.vol_5m != null ? num(r.vol_5m) : null,
      buys5m: r.buys_5m != null ? num(r.buys_5m) : null,
      sells5m: r.sells_5m != null ? num(r.sells_5m) : null,
      buys1h: r.buys_1h != null ? num(r.buys_1h) : null,
      sells1h: r.sells_1h != null ? num(r.sells_1h) : null,
      holderCount: r.holder_count != null ? num(r.holder_count) : null,
    }))
    .reverse();
}

/** GMGN top10 rate arrives as 0-1; holder_top10_pct is already a percent. */
function top10Pct(row: TokenGemRow): number | null {
  const h = row.holder_top10_pct;
  if (h != null && h > 0) return h > 1 ? h : h * 100;
  const s = row.sec_top10_holder_rate;
  if (s != null && s > 0) return s > 1 ? s : s * 100;
  return null;
}

function taxPct(v: number | null): number | null {
  if (v == null) return null;
  return v > 1 ? v : v * 100;
}

// ── Alerts ──────────────────────────────────────────────────────────────────

type GemAlertKind = "GEM_CALL" | "GEM_2X" | "GEM_5X" | "GEM_10X";

const GEM_KIND_LABEL: Record<GemAlertKind, string> = {
  GEM_CALL: "GEM CALL",
  GEM_2X: "GEM 2×",
  GEM_5X: "GEM 5×",
  GEM_10X: "GEM 10×",
};

async function fireGemAlert(opts: {
  tokenId: number;
  kind: GemAlertKind;
  row: TokenGemRow;
  result: GemResult;
  mcUsd: number;
  callMc: number | null;
}): Promise<void> {
  const { tokenId, kind, row, result, mcUsd, callMc } = opts;
  const sym = (row.symbol || row.name || row.address.slice(0, 6)).trim() || "?";
  const label = GEM_KIND_LABEL[kind];
  const mult = callMc && callMc > 0 ? mcUsd / callMc : null;

  const title = kind === "GEM_CALL"
    ? `$${sym} GEM CALL · ${result.score}/100 (conf ${(result.confidence * 100).toFixed(0)}%)`
    : `$${sym} ${label} · ${mult ? mult.toFixed(1) : "?"}× since call`;

  const bodyParts = [
    `MC ${fmtUsdCompact(mcUsd)}${callMc ? ` (call ${fmtUsdCompact(callMc)})` : ""}`,
    `GEM ${result.score} · conf ${(result.confidence * 100).toFixed(0)}% · tape ${result.snapshotsUsed}`,
    `flow ${result.components.flow} · holders ${result.components.holders} · smart ${result.components.smart}`,
    ...(result.notes.length ? [result.notes.slice(0, 3).join(" · ")] : []),
  ];
  const body = bodyParts.join(" · ");

  const inserted = await db.execute(sql`
    INSERT INTO pump_alerts (
      token_id, kind, label, title, body,
      score, grade, market_cap_usd, mc_at_detection,
      gain_pct, ath_gain_pct, symbol, name, address
    ) VALUES (
      ${tokenId}, ${kind}, ${label}, ${title}, ${body},
      ${result.score}, ${"GEM"}, ${String(mcUsd)}, ${callMc != null ? String(callMc) : null},
      ${mult != null ? (mult - 1) * 100 : null}, ${null},
      ${row.symbol}, ${row.name}, ${row.address}
    )
    ON CONFLICT (token_id, kind) DO NOTHING
    RETURNING id
  `);
  const alertRow = inserted.rows[0] as { id: number } | undefined;
  if (!alertRow) return;

  const gmgn = `https://gmgn.ai/sol/token/${row.address}`;
  const tgText = [
    `*${escTelegram(label)}*`,
    `$${escTelegram(sym)} · GEM *${result.score}*/100 · conf ${(result.confidence * 100).toFixed(0)}%`,
    `MC ${escTelegram(fmtUsdCompact(mcUsd))}${callMc ? ` · call ${escTelegram(fmtUsdCompact(callMc))}` : ""}`,
    `flow ${result.components.flow} · holders ${result.components.holders} · smart ${result.components.smart} · struct ${result.components.structure}`,
    result.notes.length ? escTelegram(result.notes.slice(0, 3).join(" · ")) : null,
    `[GMGN](${escTelegram(gmgn)})`,
  ].filter(Boolean).join("\n");

  const tg = await sendTelegramMessage(tgText);
  await db.execute(sql`
    UPDATE pump_alerts
    SET telegram_sent = ${tg.ok},
        telegram_error = ${tg.ok ? null : (tg.error ?? "send_failed")}
    WHERE id = ${alertRow.id}
  `);

  opsLog("telegram", tg.ok ? "info" : "warn",
    `GEM alert ${kind} $${sym}${tg.ok ? " → TG" : ` (tg: ${tg.error})`}`,
    { tokenId, kind, alertId: alertRow.id });

  eventBus.emit("alert:pump", {
    id: Number(alertRow.id),
    tokenId,
    kind,
    label,
    title,
    body,
    score: result.score,
    grade: "GEM",
    buySignal: null,
    intraSignal: null,
    marketCapUsd: mcUsd,
    mcAtDetection: callMc,
    gainPct: mult != null ? (mult - 1) * 100 : null,
    athGainPct: null,
    symbol: row.symbol,
    name: row.name,
    address: row.address,
    telegramSent: tg.ok,
    createdAt: new Date().toISOString(),
  });
  eventBus.emit("calls:changed", { reason: "score", tokenId, at: new Date().toISOString() });
}

// ── Main entry (called from pump-buy-scanner per scan tick) ─────────────────

export async function evaluateGemForScan(tokenId: number, pair: DexPairLike): Promise<GemResult | null> {
  const t0 = Date.now();
  try {
    const row = await loadTokenGemRow(tokenId);
    if (!row) return null;

    await writeGemSnapshot(tokenId, pair, row.holder_count);
    const tape = await loadTape(tokenId);

    const mcUsd = num(pair.marketCap ?? pair.fdv);
    const liqUsd = num(pair.liquidity?.usd);
    const pairAgeMin = pair.pairCreatedAt
      ? Math.max(0, (Date.now() - Number(pair.pairCreatedAt)) / 60_000)
      : null;

    const inputs: GemInputs = {
      mcUsd,
      liqUsd,
      vol5m: num(pair.volume?.m5),
      vol1h: num(pair.volume?.h1),
      vol24h: num(pair.volume?.h24),
      buys5m: num(pair.txns?.m5?.buys),
      sells5m: num(pair.txns?.m5?.sells),
      buys1h: num(pair.txns?.h1?.buys),
      sells1h: num(pair.txns?.h1?.sells),
      pairAgeMin,
      tape,
      holderCount: row.holder_count,
      holderTop10Pct: top10Pct(row),
      sniperCount: row.holder_sniper_count,
      bundlerCount: row.holder_bundler_count,
      smartCount: row.holder_smart_count,
      kolCount: row.holder_kol_count,
      largestClusterPct: row.holder_largest_cluster_pct,
      cabalDetected: row.holder_cabal_detected,
      holdersFresh: row.holders_age_min != null && Number(row.holders_age_min) <= HOLDERS_FRESH_MIN,
      honeypot: row.sec_is_honeypot,
      mintRenounced: row.sec_mint_renounced,
      freezeRenounced: row.sec_freeze_renounced,
      buyTaxPct: taxPct(row.sec_buy_tax),
      sellTaxPct: taxPct(row.sec_sell_tax),
      lpLocked: row.sec_lp_locked,
      securityFetched: Boolean(row.sec_fetched),
      trackedWalletBuys: Number(row.tracked_wallets ?? 0),
      prevGemStreak: Number(row.gem_streak ?? 0),
    };

    const result = computeGemScore(inputs);

    // Sticky call anchors + outcome tracking
    const isNewGem = result.verdict === "GEM" && !row.first_gem_at;
    const callMc = row.gem_call_mc_usd != null && row.gem_call_mc_usd > 0
      ? row.gem_call_mc_usd
      : (isNewGem ? mcUsd : null);
    const peak = Math.max(row.peak_after_call_mc ?? 0, callMc != null ? mcUsd : 0) || null;

    await db.execute(sql`
      INSERT INTO gem_scores (
        token_id, score, verdict, confidence, components, vetoes,
        snapshots_used, gem_streak, first_gem_at, gem_call_mc_usd,
        peak_after_call_mc, updated_at
      ) VALUES (
        ${tokenId}, ${result.score}, ${result.verdict}, ${result.confidence},
        ${JSON.stringify(result.components)}::jsonb, ${JSON.stringify(result.vetoes)}::jsonb,
        ${result.snapshotsUsed}, ${result.gemStreak},
        ${isNewGem ? new Date() : null}, ${callMc}, ${peak}, NOW()
      )
      ON CONFLICT (token_id) DO UPDATE SET
        score = EXCLUDED.score,
        verdict = EXCLUDED.verdict,
        confidence = EXCLUDED.confidence,
        components = EXCLUDED.components,
        vetoes = EXCLUDED.vetoes,
        snapshots_used = EXCLUDED.snapshots_used,
        gem_streak = EXCLUDED.gem_streak,
        first_gem_at = COALESCE(gem_scores.first_gem_at, EXCLUDED.first_gem_at),
        gem_call_mc_usd = COALESCE(gem_scores.gem_call_mc_usd, EXCLUDED.gem_call_mc_usd),
        peak_after_call_mc = GREATEST(COALESCE(gem_scores.peak_after_call_mc, 0), COALESCE(EXCLUDED.peak_after_call_mc, 0)),
        updated_at = NOW()
    `);

    // Alerts: the call itself, then outcome milestones vs call MC
    if (isNewGem) {
      await fireGemAlert({ tokenId, kind: "GEM_CALL", row, result, mcUsd, callMc });
      log.info({ tokenId, score: result.score, conf: result.confidence, notes: result.notes },
        "GEM CALL fired");
    } else if (callMc != null && callMc > 0 && mcUsd > 0) {
      const mult = mcUsd / callMc;
      if (mult >= 10) await fireGemAlert({ tokenId, kind: "GEM_10X", row, result, mcUsd, callMc });
      else if (mult >= 5) await fireGemAlert({ tokenId, kind: "GEM_5X", row, result, mcUsd, callMc });
      else if (mult >= 2) await fireGemAlert({ tokenId, kind: "GEM_2X", row, result, mcUsd, callMc });
    }

    evalsSincePrune += 1;
    if (evalsSincePrune >= PRUNE_EVERY_N) {
      evalsSincePrune = 0;
      void pruneGemSnapshots();
    }

    healthMonitor.ok("gem-engine", Date.now() - t0);
    return result;
  } catch (err) {
    healthMonitor.error("gem-engine", err);
    log.warn({ err, tokenId }, "gem evaluation failed");
    return null;
  }
}
