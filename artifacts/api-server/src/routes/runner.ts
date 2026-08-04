/**
 * Runner Entry API — canonical production endpoints
 *
 * GET /api/runner/feed     — desk cards (Radar / Heating / Entry / …)
 * GET /api/runner/stats    — ping + desk performance
 * GET /api/runner/alerts   — ENTRY sends + live heating/entry lanes
 * GET /api/runner/token/:id — detail + velocity series
 *
 * Envelope: { ok, data, meta: { ts, version } }
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { apiFail, apiOk } from "../lib/api-envelope";
import { proCacheGet, proCacheSet, toIsoUtc } from "../lib/pro-cache";
import { extractSocials } from "../lib/socials";
import { publicApiOrigin } from "../lib/public-url";
import { deriveRunStatus } from "../lib/pro-scoring";
import { deriveProOutcome } from "../lib/pro-outcome";
import {
  computeRunnerScore,
  type RunnerPhase,
} from "../lib/runner-score";
import { convictionFieldsFromVerified } from "../lib/pro-confidence";
import { isProBannedToken } from "../lib/solana-memecoin-gate";

const router = Router();
const CACHE_TTL = 6;

function resolveLogoUri(imagePath: unknown, logoUri: unknown): string | null {
  const external = logoUri != null ? String(logoUri).trim() : "";
  if (/^https?:\/\//i.test(external)) return external;
  const path = imagePath != null ? String(imagePath).trim() : "";
  if (path) {
    const rel = path.startsWith("/api/assets")
      ? path
      : `/api/assets${path.startsWith("/") ? path : `/${path}`}`;
    const base = publicApiOrigin();
    return base ? `${base}${rel}` : rel;
  }
  return external || null;
}

type RunnerCard = {
  id: number;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  logoUri: string | null;
  calledAt: string | null;
  calledMcUsd: number | null;
  currentMcUsd: number | null;
  calledIntel: number | null;
  calledSmart: number;
  calledKol: number;
  gainPct: number | null;
  athMultiple: number;
  velocity: number;
  proScore: number;
  qualityLabel: string;
  runStatus: string;
  hit2x: boolean;
  hit5x: boolean;
  hit10x: boolean;
  runnerAlertSentAt: string | null;
  secMintRenounced: boolean | null;
  secIsHoneypot: boolean | null;
  socials: { twitter?: string; telegram?: string; website?: string };
  outcome: ReturnType<typeof deriveProOutcome>;
  runner: {
    score: number;
    phase: RunnerPhase;
    label: string;
    alertEligible: boolean;
    reasons: string[];
    blockers: string[];
    sizeLabel: string;
    signals: {
      velocity: number;
      gainPct: number;
      taggedOk: boolean;
      mintOk: boolean;
      freshnessOk: boolean;
    };
  };
};

async function loadRunnerFeed(limit: number): Promise<{ tokens: RunnerCard[]; total: number }> {
  const cacheKey = `runner:feed:v1:${limit}`;
  const cached = await proCacheGet<{ tokens: RunnerCard[]; total: number }>(cacheKey);
  if (cached?.tokens?.length) return cached;

  const head = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM pro_calls
    WHERE surfaced_at IS NOT NULL AND quality_label IN ('very_good', 'good')
  `);
  const total = Number((head.rows[0] as { n?: number })?.n ?? 0);

  const callRows = await db.execute(sql`
    SELECT
      pc.token_id, pc.called_at, pc.called_mc_usd, pc.called_intel_score,
      pc.called_kol_count, pc.called_smart_count, pc.called_holder_velocity,
      pc.ath_multiple, pc.pro_score, pc.quality_label,
      pc.hit_2x, pc.hit_5x, pc.hit_10x,
      pc.surfaced_at, pc.verified_wallets, pc.runner_score, pc.runner_phase,
      pc.runner_alert_sent_at, pc.call_alert_sent_at,
      GREATEST(
        COALESCE(pc.observation_snap_count, 0),
        (SELECT COUNT(*)::int FROM pro_snapshots ps WHERE ps.pro_call_id = pc.id)
      ) AS snap_count,
      t.address, t.chain, t.name, t.symbol, t.logo_uri, t.image_path,
      t.market_cap_usd, t.raw_metadata,
      t.holder_kol_count AS live_kol, t.holder_smart_count AS live_smart,
      t.volume_intensity_score, t.holder_velocity_score,
      t.sec_is_honeypot, t.sec_mint_renounced, t.sec_freeze_renounced
    FROM pro_calls pc
    JOIN tracked_tokens t ON t.id = pc.token_id
    WHERE pc.surfaced_at IS NOT NULL
      AND pc.quality_label IN ('very_good', 'good')
      AND COALESCE(t.status, '') <> 'ignored'
    ORDER BY
      CASE pc.runner_phase
        WHEN 'entry' THEN 0
        WHEN 'heating' THEN 1
        WHEN 'radar' THEN 2
        WHEN 'fading' THEN 3
        ELSE 4
      END,
      pc.called_at DESC NULLS LAST
    LIMIT ${limit}
  `);

  const tokens: RunnerCard[] = (callRows.rows as Array<Record<string, unknown>>).map(call => {
    const calledMc = call.called_mc_usd ? parseFloat(String(call.called_mc_usd)) : null;
    const currentMc = parseFloat(String(call.market_cap_usd ?? "0")) || null;
    const gainPct = calledMc && currentMc ? ((currentMc - calledMc) / calledMc) * 100 : null;
    const athMultiple = Number(call.ath_multiple ?? 1) || 1;
    const velocity = calledMc && currentMc && calledMc > 0 ? currentMc / calledMc : 1;
    const runStatus = deriveRunStatus(currentMc, calledMc, athMultiple);
    const ban = isProBannedToken({
      address: call.address != null ? String(call.address) : null,
      symbol: call.symbol != null ? String(call.symbol) : null,
      calledMcUsd: calledMc,
      currentMcUsd: currentMc,
    });
    const outcome = deriveProOutcome({
      calledMcUsd: calledMc,
      currentMcUsd: currentMc,
      athMultiple,
      runStatus,
      honeypot: call.sec_is_honeypot as boolean | null,
      banned: ban.banned,
    });
    const ageMin = call.called_at
      ? (Date.now() - new Date(String(call.called_at)).getTime()) / 60_000
      : 9999;
    const vw = convictionFieldsFromVerified(call.verified_wallets);
    const prevPhase = call.runner_phase != null
      ? String(call.runner_phase) as RunnerPhase
      : null;
    const prevScore = call.runner_score != null ? Number(call.runner_score) : null;
    const runner = computeRunnerScore({
      calledIntelScore: call.called_intel_score != null ? Number(call.called_intel_score) : null,
      calledSmartCount: Number(call.called_smart_count ?? 0),
      calledKolCount: Number(call.called_kol_count ?? 0),
      calledMcUsd: calledMc,
      currentMcUsd: currentMc,
      athMultiple,
      gainPct: gainPct ?? 0,
      ageMinutes: ageMin,
      velocity,
      snapDeltaPct: null,
      liveSmart: Number(call.live_smart ?? 0),
      liveKol: Number(call.live_kol ?? 0),
      secIsHoneypot: call.sec_is_honeypot as boolean | null,
      secMintRenounced: call.sec_mint_renounced as boolean | null,
      secFreezeRenounced: call.sec_freeze_renounced as boolean | null,
      holderVelocityScore: call.holder_velocity_score != null ? Number(call.holder_velocity_score) : null,
      volumeIntensityScore: call.volume_intensity_score != null ? Number(call.volume_intensity_score) : null,
      smartHoldRate: vw.smartHoldRate,
      prevPhase,
      prevScore,
      snapCount: Number(call.snap_count ?? 0) || 0,
    });

    return {
      id: Number(call.token_id),
      address: String(call.address),
      chain: String(call.chain ?? "solana"),
      name: (call.name as string | null) ?? null,
      symbol: (call.symbol as string | null) ?? null,
      logoUri: resolveLogoUri(call.image_path, call.logo_uri),
      calledAt: toIsoUtc(call.called_at),
      calledMcUsd: calledMc,
      currentMcUsd: currentMc,
      calledIntel: call.called_intel_score != null ? Number(call.called_intel_score) : null,
      calledSmart: Number(call.called_smart_count ?? 0),
      calledKol: Number(call.called_kol_count ?? 0),
      gainPct,
      athMultiple,
      velocity: Math.round(velocity * 100) / 100,
      proScore: Number(call.pro_score ?? 0),
      qualityLabel: String(call.quality_label ?? "good"),
      runStatus,
      hit2x: Boolean(call.hit_2x),
      hit5x: Boolean(call.hit_5x),
      hit10x: Boolean(call.hit_10x),
      runnerAlertSentAt: toIsoUtc(call.runner_alert_sent_at ?? call.call_alert_sent_at),
      secMintRenounced: call.sec_mint_renounced as boolean | null,
      secIsHoneypot: call.sec_is_honeypot as boolean | null,
      socials: extractSocials(call.raw_metadata),
      outcome,
      runner: {
        score: runner.score,
        phase: runner.phase,
        label: runner.label,
        alertEligible: runner.alertEligible,
        reasons: runner.reasons,
        blockers: runner.blockers,
        sizeLabel: runner.sizeLabel,
        signals: runner.signals,
      },
    };
  });

  const payload = { tokens, total };
  await proCacheSet(cacheKey, payload, CACHE_TTL);
  return payload;
}

router.get("/runner/feed", async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "200"), 10) || 200, 1), 400);
    const phase = String(req.query.phase ?? "all");
    const feed = await loadRunnerFeed(limit);
    let tokens = feed.tokens;
    if (phase !== "all") {
      tokens = tokens.filter(t => t.runner.phase === phase);
    }
    res.setHeader("Cache-Control", "private, max-age=4");
    res.json(apiOk(
      { tokens, total: tokens.length, totalAll: feed.total },
      { cache: "runner-feed", phase },
    ));
  } catch (err) {
    console.error("runner feed error", err);
    res.status(500).json(apiFail("Internal server error", "runner_feed"));
  }
});

router.get("/runner/stats", async (_req, res) => {
  try {
    const cacheKey = "runner:stats:v1";
    const cached = await proCacheGet<Record<string, unknown>>(cacheKey);
    if (cached) {
      res.json(apiOk(cached, { cache: "hit" }));
      return;
    }

    const result = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE surfaced_at IS NOT NULL AND quality_label IN ('very_good','good')
        )::int AS desk,
        COUNT(*) FILTER (
          WHERE runner_alert_sent_at IS NOT NULL OR call_alert_sent_at IS NOT NULL
        )::int AS entries_sent,
        COUNT(*) FILTER (
          WHERE (runner_alert_sent_at IS NOT NULL OR call_alert_sent_at IS NOT NULL)
            AND (hit_2x OR COALESCE(ath_multiple,1) >= 2)
        )::int AS entry_x2,
        COUNT(*) FILTER (
          WHERE (runner_alert_sent_at IS NOT NULL OR call_alert_sent_at IS NOT NULL)
            AND (hit_5x OR COALESCE(ath_multiple,1) >= 5)
        )::int AS entry_x5,
        COUNT(*) FILTER (
          WHERE (runner_alert_sent_at IS NOT NULL OR call_alert_sent_at IS NOT NULL)
            AND (hit_10x OR COALESCE(ath_multiple,1) >= 10)
        )::int AS entry_x10,
        COUNT(*) FILTER (WHERE runner_phase = 'entry')::int AS live_entry,
        COUNT(*) FILTER (WHERE runner_phase = 'heating')::int AS live_heating,
        COUNT(*) FILTER (WHERE runner_phase = 'radar')::int AS live_radar,
        MAX(ath_multiple) FILTER (
          WHERE surfaced_at IS NOT NULL AND quality_label IN ('very_good','good')
        ) AS best_ath
      FROM pro_calls
    `);
    const r = (result.rows[0] ?? {}) as Record<string, unknown>;
    const sent = Number(r.entries_sent ?? 0);
    const data = {
      desk: Number(r.desk ?? 0),
      entriesSent: sent,
      entryWinRate2x: sent ? Math.round((Number(r.entry_x2 ?? 0) / sent) * 100) : 0,
      entryWinRate5x: sent ? Math.round((Number(r.entry_x5 ?? 0) / sent) * 100) : 0,
      entryWinRate10x: sent ? Math.round((Number(r.entry_x10 ?? 0) / sent) * 100) : 0,
      x2Count: Number(r.entry_x2 ?? 0),
      x5Count: Number(r.entry_x5 ?? 0),
      x10Count: Number(r.entry_x10 ?? 0),
      liveEntry: Number(r.live_entry ?? 0),
      liveHeating: Number(r.live_heating ?? 0),
      liveRadar: Number(r.live_radar ?? 0),
      bestAth: r.best_ath != null ? Number(r.best_ath) : null,
    };
    await proCacheSet(cacheKey, data, 10);
    res.json(apiOk(data, { cache: "miss" }));
  } catch (err) {
    console.error("runner stats error", err);
    res.status(500).json(apiFail("Internal server error", "runner_stats"));
  }
});

router.get("/runner/alerts", async (_req, res) => {
  try {
    const feed = await loadRunnerFeed(300);
    const sent = feed.tokens
      .filter(t => t.runnerAlertSentAt)
      .sort((a, b) => (b.runnerAlertSentAt ?? "").localeCompare(a.runnerAlertSentAt ?? ""));
    const entry = feed.tokens.filter(t => t.runner.phase === "entry" || t.runner.alertEligible);
    const heating = feed.tokens.filter(t => t.runner.phase === "heating");
    const sentN = sent.length;
    const x2 = sent.filter(t => t.hit2x || t.athMultiple >= 2).length;
    const x5 = sent.filter(t => t.hit5x || t.athMultiple >= 5).length;
    const x10 = sent.filter(t => t.hit10x || t.athMultiple >= 10).length;

    res.setHeader("Cache-Control", "private, max-age=4");
    res.json(apiOk({
      stats: {
        sent: sentN,
        winRate2x: sentN ? Math.round((x2 / sentN) * 100) : 0,
        winRate5x: sentN ? Math.round((x5 / sentN) * 100) : 0,
        winRate10x: sentN ? Math.round((x10 / sentN) * 100) : 0,
        x2Count: x2,
        x5Count: x5,
        x10Count: x10,
        liveEntry: entry.length,
        liveHeating: heating.length,
      },
      sent,
      entry,
      heating,
    }));
  } catch (err) {
    console.error("runner alerts error", err);
    res.status(500).json(apiFail("Internal server error", "runner_alerts"));
  }
});

router.get("/runner/token/:tokenId", async (req, res) => {
  try {
    const tokenId = parseInt(req.params.tokenId, 10);
    if (!Number.isFinite(tokenId)) {
      res.status(400).json(apiFail("Invalid token ID", "bad_request"));
      return;
    }

    const feed = await loadRunnerFeed(400);
    const card = feed.tokens.find(t => t.id === tokenId);
    if (!card) {
      // Fall through — may be unscored; still return snaps if pro_call exists
    }

    const snaps = await db.execute(sql`
      SELECT snapshot_at, mc_usd, ath_multiple, gain_pct, kol_count, smart_count,
             intel_score, pro_score, run_status, holder_velocity_score,
             volume_intensity_score,
             runner_score, runner_phase, velocity, phase_changed
      FROM pro_snapshots
      WHERE token_id = ${tokenId}
      ORDER BY snapshot_at ASC
      LIMIT 120
    `);

    const velocitySeries = (snaps.rows as Array<Record<string, unknown>>).map(s => ({
      at: toIsoUtc(s.snapshot_at),
      mcUsd: s.mc_usd != null ? parseFloat(String(s.mc_usd)) : null,
      athMultiple: s.ath_multiple != null ? Number(s.ath_multiple) : null,
      gainPct: s.gain_pct != null ? Number(s.gain_pct) : null,
      kol: Number(s.kol_count ?? 0),
      smart: Number(s.smart_count ?? 0),
      intel: s.intel_score != null ? Number(s.intel_score) : null,
      proScore: s.pro_score != null ? Number(s.pro_score) : null,
      runStatus: s.run_status != null ? String(s.run_status) : null,
      runnerScore: s.runner_score != null ? Number(s.runner_score) : null,
      runnerPhase: s.runner_phase != null ? String(s.runner_phase) : null,
      velocity: s.velocity != null ? Number(s.velocity) : null,
      phaseChanged: Number(s.phase_changed ?? 0) === 1,
    }));

    res.json(apiOk({
      token: card ?? null,
      velocitySeries,
    }));
  } catch (err) {
    console.error("runner token error", err);
    res.status(500).json(apiFail("Internal server error", "runner_token"));
  }
});

export default router;
