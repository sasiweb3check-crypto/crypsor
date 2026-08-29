/**
 * Token list — wallet buys only. Search, pagination, performers by gain %.
 * Optional early band ($5k–$30k detected) is a filter, never a gate.
 */
import { pool } from "../core/db";
import { tokenImageUrl } from "../scoring/image";
import {
  entryOf, gainMatrix, gainPct, inEarlyBand, labelOf, statusOf,
  SCORE_BUCKETS, type AlertLane, type DeskLabel, type GainMatrix, type RugKind, type ScoreBucketName, type TokenStatus,
} from "../scoring/desk";

export type { DeskLabel, GainMatrix, TokenStatus };

export type TokenCard = {
  id: number;
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  detected_mc: number | null;
  last_mc: number | null;
  peak_mc: number | null;
  last_liq: number | null;
  gain_pct: number | null;
  ath_pct: number | null;
  wallet_buys: number;
  status: TokenStatus;
  label: DeskLabel;
  score: number | null;
  prev_score: number | null;
  score_at: string | null;
  rug: RugKind;
  entry_mc: number | null;
  holders: number | null;
  holders_rug: boolean;
  top10_excl_lp: number | null;
  cluster_n: number | null;
  discovered_at: string;
  last_scan_at: string | null;
};

export type DeskMemory = {
  at: string;
  mc_usd: number | null;
  liq_usd: number | null;
  gain_pct: number | null;
  wallets: number | null;
  status: string | null;
  label: string | null;
  survived: boolean | null;
  score: number | null;
  prev_score: number | null;
  score_delta: number | null;
  mc_delta_pct: number | null;
  liq_delta_pct: number | null;
  wallet_delta: number | null;
  band: string | null;
  catalyst: string | null;
  factors: Record<string, number> | null;
  vol_5m: number | null;
  vol_h1: number | null;
  buys_5m: number | null;
  sells_5m: number | null;
  holders: number | null;
  buy_ratio: number | null;
  boosts: number | null;
  replies: number | null;
  price_chg_m5: number | null;
  rug: string | null;
  survival: Record<string, unknown> | null;
  top10_pct: number | null;
  top10_excl_lp: number | null;
  cluster_n: number | null;
  holders_rug: boolean | null;
};

const SELECT = `SELECT t.id, t.mint, t.symbol, t.name, t.image, t.wallet_buys,
            t.detected_mc, t.admission_mc, t.last_mc, t.peak_mc, t.last_liq, t.last_holders,
            t.last_top10_excl_lp, t.last_cluster_n, t.last_holders_rug,
            t.discovered_at, t.last_scan_at, t.desk_score, t.desk_prev_score, t.desk_score_at, t.last_rug
     FROM f2_tokens t`;

const SELECT_BASIC = `SELECT t.id, t.mint, t.symbol, t.name, t.image, t.wallet_buys,
            t.detected_mc, t.admission_mc, t.last_mc, t.peak_mc, t.last_liq,
            t.discovered_at, t.last_scan_at
     FROM f2_tokens t`;

const WHERE_BUYS = `t.wallet_buys > 0`;

function card(row: Record<string, unknown>): TokenCard {
  const detected = row.detected_mc != null ? Number(row.detected_mc)
    : (row.admission_mc != null ? Number(row.admission_mc) : null);
  const last = row.last_mc != null ? Number(row.last_mc) : null;
  const peak = row.peak_mc != null ? Number(row.peak_mc) : last;
  const mint = String(row.mint);
  const walletBuys = Number(row.wallet_buys ?? 0);
  const score = row.desk_score != null ? Number(row.desk_score) : null;
  const rug = (row.last_rug === "rug" || row.last_rug === "dump" || row.last_rug === "caution")
    ? row.last_rug as RugKind
    : "none";
  const holdersRug = row.last_holders_rug === true;
  const top10Excl = row.last_top10_excl_lp != null ? Number(row.last_top10_excl_lp) : null;
  const clusterN = row.last_cluster_n != null ? Number(row.last_cluster_n) : null;
  const status = statusOf(last, detected);
  return {
    id: Number(row.id),
    mint,
    symbol: (row.symbol as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    image: tokenImageUrl((row.image as string | null) ?? null, mint),
    detected_mc: detected,
    last_mc: last,
    peak_mc: peak,
    last_liq: row.last_liq != null ? Number(row.last_liq) : null,
    gain_pct: gainPct(last, detected),
    ath_pct: gainPct(peak, detected),
    wallet_buys: walletBuys,
    status,
    label: labelOf({ lastMc: last, detectedMc: detected, walletBuys, score, rug }),
    score,
    prev_score: row.desk_prev_score != null ? Number(row.desk_prev_score) : null,
    score_at: row.desk_score_at ? new Date(row.desk_score_at as string).toISOString() : null,
    rug,
    entry_mc: entryOf({ lastMc: last, score, survived: status !== "dead", rug, holdersRug }),
    holders: row.last_holders != null ? Number(row.last_holders) : null,
    holders_rug: holdersRug,
    top10_excl_lp: top10Excl,
    cluster_n: clusterN,
    discovered_at: new Date(row.discovered_at as string).toISOString(),
    last_scan_at: row.last_scan_at ? new Date(row.last_scan_at as string).toISOString() : null,
  };
}

export type ScoreStat = {
  bucket: ScoreBucketName;
  n: number;
  hit2x: number;
  hit5x: number;
  pct2x: number;
  pct5x: number;
};

export type NoticeItem = {
  id: number;
  tokenId: number;
  kind: string;
  title: string;
  body: string;
  lane: AlertLane | string;
  score: number | null;
  at: string;
  symbol: string | null;
  mint: string | null;
};

export type NoticeBoard = {
  at: string;
  items: NoticeItem[];
  scoreStats: ScoreStat[];
};

export type BoardQuery = {
  q?: string;
  status?: TokenStatus | "all" | "active";
  band?: "early" | "all";
  scoreMin?: number;
  gainMin?: number;
  sort?: "score" | "gain" | "ath" | "new";
  page?: number;
  limit?: number;
};

export type TokenBoard = {
  at: string;
  items: TokenCard[];
  performers: TokenCard[];
  census: {
    all: number;
    live: number;
    running: number;
    dead: number;
    early: number;
    active: number;
    high: number;
    score40: number;
    score60: number;
    score80: number;
    rugs: number;
  };
  matrix: GainMatrix | null;
  scoreStats: ScoreStat[] | null;
  band: "early" | "all";
  scoreMin: number;
  gainMin: number;
  sort: "score" | "gain" | "ath" | "new";
  page: number;
  pages: number;
  total: number;
  limit: number;
};

export async function listTokens(opts: BoardQuery = {}): Promise<TokenBoard> {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 80);
  const offset = (page - 1) * limit;
  const q = (opts.q ?? "").trim();
  const status = opts.status ?? "active";
  const band = opts.band === "early" ? "early" : "all";
  const scoreMin = opts.scoreMin != null && Number.isFinite(opts.scoreMin) ? Math.max(0, opts.scoreMin) : 0;
  const gainMin = opts.gainMin != null && Number.isFinite(opts.gainMin) ? Math.max(0, opts.gainMin) : 0;
  const sort = opts.sort === "gain" || opts.sort === "ath" || opts.sort === "new" || opts.sort === "score"
    ? opts.sort
    : "score";

  const all = await pool.query(
    `${SELECT} WHERE ${WHERE_BUYS}
     ORDER BY t.discovered_at DESC
     LIMIT 5000`,
  ).catch(() => pool.query(
    `${SELECT_BASIC} WHERE ${WHERE_BUYS}
     ORDER BY t.discovered_at DESC
     LIMIT 5000`,
  ));
  const cards = all.rows.map((r) => card(r as Record<string, unknown>));

  const needle = q.toLowerCase();
  const searched = needle
    ? cards.filter((c) =>
      (c.symbol ?? "").toLowerCase().includes(needle)
      || (c.name ?? "").toLowerCase().includes(needle)
      || c.mint.toLowerCase().includes(needle))
    : cards;

  const earlyN = searched.filter((c) => inEarlyBand(c.detected_mc)).length;
  const banded = band === "early"
    ? searched.filter((c) => inEarlyBand(c.detected_mc))
    : searched;

  const census = {
    all: banded.length,
    live: banded.filter((c) => c.status === "live").length,
    running: banded.filter((c) => c.status === "running").length,
    dead: banded.filter((c) => c.status === "dead").length,
    early: earlyN,
    active: banded.filter((c) => c.status !== "dead").length,
    high: banded.filter((c) =>
      c.status !== "dead" && (c.score ?? 0) >= 40 && c.rug !== "dump" && c.rug !== "rug" && !c.holders_rug
    ).length,
    score40: banded.filter((c) => (c.score ?? 0) >= 40).length,
    score60: banded.filter((c) => (c.score ?? 0) >= 60).length,
    score80: banded.filter((c) => (c.score ?? 0) >= 80).length,
    rugs: banded.filter((c) => c.rug === "dump" || c.rug === "rug").length,
  };

  let filtered = banded;
  if (status === "active") filtered = filtered.filter((c) => c.status !== "dead");
  else if (status !== "all") filtered = filtered.filter((c) => c.status === status);
  if (scoreMin > 0) filtered = filtered.filter((c) => (c.score ?? 0) >= scoreMin);
  if (gainMin >= 2) filtered = filtered.filter((c) => c.gain_pct != null && 1 + c.gain_pct / 100 >= gainMin);
  if (status === "active" && scoreMin >= 40) {
    filtered = filtered.filter((c) => c.rug !== "dump" && c.rug !== "rug" && !c.holders_rug);
  }

  const ranked = [...filtered].sort((a, b) => {
    if (sort === "gain") return (b.gain_pct ?? -999) - (a.gain_pct ?? -999);
    if (sort === "ath") return (b.ath_pct ?? -999) - (a.ath_pct ?? -999);
    if (sort === "new") return new Date(b.discovered_at).getTime() - new Date(a.discovered_at).getTime();
    return (b.score ?? -1) - (a.score ?? -1);
  });

  const performers = [...filtered]
    .filter((c) => c.status !== "dead" && c.rug !== "dump" && c.rug !== "rug" && !c.holders_rug)
    .sort((a, b) => (b.gain_pct ?? -999) - (a.gain_pct ?? -999))
    .slice(0, 8);

  const total = ranked.length;
  const items = ranked.slice(offset, offset + limit);

  return {
    at: new Date().toISOString(),
    items,
    performers,
    census,
    matrix: band === "early" ? gainMatrix(banded) : gainMatrix(filtered),
    scoreStats: await scoreStats(),
    band,
    scoreMin,
    gainMin,
    sort,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    total,
    limit,
  };
}

function mapMemory(s: Record<string, unknown>): DeskMemory {
  const factorsRaw = s.factors;
  let factors: Record<string, number> | null = null;
  if (factorsRaw && typeof factorsRaw === "object" && !Array.isArray(factorsRaw)) {
    factors = {};
    for (const [k, v] of Object.entries(factorsRaw as Record<string, unknown>)) {
      const n = Number(v);
      if (Number.isFinite(n)) factors[k] = n;
    }
  }
  const n = (k: string) => (s[k] != null && Number.isFinite(Number(s[k])) ? Number(s[k]) : null);
  return {
    at: new Date(s.at as string | Date).toISOString(),
    mc_usd: n("mc_usd"),
    liq_usd: n("liq_usd"),
    gain_pct: n("gain_pct"),
    wallets: n("wallets"),
    status: (s.status as string | null) ?? null,
    label: (s.label as string | null) ?? null,
    survived: s.survived == null ? null : Boolean(s.survived),
    score: n("score"),
    prev_score: n("prev_score"),
    score_delta: n("score_delta"),
    mc_delta_pct: n("mc_delta_pct"),
    liq_delta_pct: n("liq_delta_pct"),
    wallet_delta: n("wallet_delta"),
    band: (s.band as string | null) ?? null,
    catalyst: (s.catalyst as string | null) ?? null,
    factors,
    vol_5m: n("vol_5m"),
    vol_h1: n("vol_h1"),
    buys_5m: n("buys_5m"),
    sells_5m: n("sells_5m"),
    holders: n("holders"),
    buy_ratio: n("buy_ratio"),
    boosts: n("boosts"),
    replies: n("replies"),
    price_chg_m5: n("price_chg_m5"),
    rug: (s.rug as string | null) ?? null,
    survival: s.survival && typeof s.survival === "object" && !Array.isArray(s.survival)
      ? s.survival as Record<string, unknown>
      : null,
    top10_pct: n("top10_pct"),
    top10_excl_lp: n("top10_excl_lp"),
    cluster_n: n("cluster_n"),
    holders_rug: s.holders_rug == null ? null : Boolean(s.holders_rug),
  };
}

export async function getToken(id: number): Promise<{
  token: TokenCard;
  admissions: Array<{ wallet: string; sig: string | null; at: string; label: string | null }>;
  scans: Array<{ at: string; mc_usd: number | null; liq_usd: number | null; phase: string | null }>;
  memory: DeskMemory[];
} | null> {
  const r = await pool.query(`${SELECT} WHERE t.id = $1 AND ${WHERE_BUYS}`, [id])
    .catch(() => pool.query(`${SELECT_BASIC} WHERE t.id = $1 AND ${WHERE_BUYS}`, [id]));
  if (!r.rows[0]) return null;
  const token = card(r.rows[0] as Record<string, unknown>);
  const ads = await pool.query(
    `SELECT a.wallet, a.sig, a.at, w.label
     FROM ward_admissions a
     LEFT JOIN walletdatasource w ON w.address = a.wallet
     WHERE a.token_id = $1
     ORDER BY a.at ASC`,
    [id],
  );
  const scans = await pool.query(
    `SELECT at, mc_usd, liq_usd, phase
     FROM f2_scans WHERE token_id = $1 ORDER BY at DESC LIMIT 40`,
    [id],
  );
  let memory: DeskMemory[] = [];
  try {
    const mem = await pool.query(
      `SELECT at, mc_usd, liq_usd, gain_pct, wallets, status, label, survived,
              score, prev_score, score_delta, mc_delta_pct, liq_delta_pct, wallet_delta, band,
              catalyst, factors, vol_5m, vol_h1, buys_5m, sells_5m, holders, buy_ratio, boosts, replies, price_chg_m5,
              survival, rug, top10_pct, top10_excl_lp, cluster_n, holders_rug
       FROM desk_memory WHERE token_id = $1 ORDER BY at DESC LIMIT 40`,
      [id],
    );
    memory = mem.rows.map((row) => mapMemory(row as Record<string, unknown>));
  } catch {
    try {
      const mem = await pool.query(
        `SELECT at, mc_usd, liq_usd, gain_pct, wallets, status, label, survived,
                score, prev_score, score_delta, mc_delta_pct, liq_delta_pct, wallet_delta, band,
                catalyst, factors, vol_5m, vol_h1, buys_5m, sells_5m, holders, buy_ratio, boosts, replies, price_chg_m5,
                survival, rug
         FROM desk_memory WHERE token_id = $1 ORDER BY at DESC LIMIT 40`,
        [id],
      );
      memory = mem.rows.map((row) => mapMemory(row as Record<string, unknown>));
    } catch {
      try {
        const mem = await pool.query(
          `SELECT at, mc_usd, liq_usd, gain_pct, wallets, status, label, survived,
                  score, prev_score, score_delta, mc_delta_pct, liq_delta_pct, wallet_delta, band,
                  catalyst
           FROM desk_memory WHERE token_id = $1 ORDER BY at DESC LIMIT 40`,
          [id],
        );
        memory = mem.rows.map((row) => mapMemory(row as Record<string, unknown>));
      } catch {
        memory = [];
      }
    }
  }
  return {
    token,
    admissions: ads.rows.map((a: { wallet: string; sig: string | null; at: string | Date; label: string | null }) => ({
      wallet: a.wallet,
      sig: a.sig,
      at: new Date(a.at).toISOString(),
      label: a.label,
    })),
    scans: scans.rows.map((s: { at: string | Date; mc_usd: number | null; liq_usd: number | null; phase: string | null }) => ({
      at: new Date(s.at).toISOString(),
      mc_usd: s.mc_usd != null ? Number(s.mc_usd) : null,
      liq_usd: s.liq_usd != null ? Number(s.liq_usd) : null,
      phase: s.phase,
    })),
    memory,
  };
}

export async function scoreStats(): Promise<ScoreStat[]> {
  const empty: ScoreStat[] = SCORE_BUCKETS.map((bucket) => ({
    bucket, n: 0, hit2x: 0, hit5x: 0, pct2x: 0, pct5x: 0,
  }));
  try {
    const r = await pool.query(
      `SELECT
         CASE
           WHEN m.score < 20 THEN '0-19'
           WHEN m.score < 40 THEN '20-39'
           WHEN m.score < 60 THEN '40-59'
           WHEN m.score < 80 THEN '60-79'
           ELSE '80-100'
         END AS bucket,
         COUNT(*)::int AS n,
         COUNT(*) FILTER (WHERE t.peak_mc >= m.detected_mc * 2)::int AS hit2x,
         COUNT(*) FILTER (WHERE t.peak_mc >= m.detected_mc * 5)::int AS hit5x
       FROM desk_memory m
       JOIN f2_tokens t ON t.id = m.token_id
       WHERE m.score IS NOT NULL
         AND t.wallet_buys > 0
       GROUP BY 1`,
    );
    const by = new Map(empty.map((s) => [s.bucket, s]));
    for (const row of r.rows as Array<{ bucket: ScoreBucketName; n: number; hit2x: number; hit5x: number }>) {
      const n = Number(row.n) || 0;
      by.set(row.bucket, {
        bucket: row.bucket,
        n,
        hit2x: Number(row.hit2x) || 0,
        hit5x: Number(row.hit5x) || 0,
        pct2x: n ? ((Number(row.hit2x) || 0) / n) * 100 : 0,
        pct5x: n ? ((Number(row.hit5x) || 0) / n) * 100 : 0,
      });
    }
    return SCORE_BUCKETS.map((b) => by.get(b) ?? { bucket: b, n: 0, hit2x: 0, hit5x: 0, pct2x: 0, pct5x: 0 });
  } catch {
    return empty;
  }
}

export async function listNotices(): Promise<NoticeBoard> {
  let items: NoticeItem[] = [];
  try {
    const r = await pool.query(
      `SELECT a.id, a.token_id AS "tokenId", a.kind, a.title, a.body,
              COALESCE(a.lane, a.payload->>'lane', 'high') AS lane,
              COALESCE(a.score, (a.payload->>'score')::real) AS score,
              a.at, t.symbol, t.mint
       FROM ward_alerts a
       LEFT JOIN f2_tokens t ON t.id = a.token_id
       WHERE a.kind IN ('admit', 'rung', 'score', 'rug')
       ORDER BY a.id DESC
       LIMIT 80`,
    );
    items = r.rows.map((row: {
      id: number;
      tokenId: number;
      kind: string;
      title: string;
      body: string;
      lane: string;
      score: number | null;
      at: string | Date;
      symbol: string | null;
      mint: string | null;
    }) => ({
      id: Number(row.id),
      tokenId: Number(row.tokenId),
      kind: row.kind,
      title: row.title,
      body: row.body,
      lane: row.lane === "early" || row.lane === "call" ? row.lane : "high",
      score: row.score != null ? Number(row.score) : null,
      at: new Date(row.at).toISOString(),
      symbol: row.symbol,
      mint: row.mint,
    }));
  } catch {
    items = [];
  }
  return {
    at: new Date().toISOString(),
    items,
    scoreStats: await scoreStats(),
  };
}
