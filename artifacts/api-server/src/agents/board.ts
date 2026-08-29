/**
 * Token list — wallet buys only. Search, pagination, performers by gain %.
 * Optional early band ($5k–$30k detected) is a filter, never a gate.
 */
import { pool } from "../core/db";
import { tokenImageUrl } from "../scoring/image";
import {
  gainMatrix, gainPct, inEarlyBand, labelOf, statusOf,
  type DeskLabel, type GainMatrix, type TokenStatus,
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
};

const SELECT = `SELECT t.id, t.mint, t.symbol, t.name, t.image, t.wallet_buys,
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
    status: statusOf(last, detected),
    label: labelOf({ lastMc: last, detectedMc: detected, walletBuys }),
    discovered_at: new Date(row.discovered_at as string).toISOString(),
    last_scan_at: row.last_scan_at ? new Date(row.last_scan_at as string).toISOString() : null,
  };
}

export type BoardQuery = {
  q?: string;
  status?: TokenStatus | "all";
  band?: "early" | "all";
  page?: number;
  limit?: number;
};

export type TokenBoard = {
  at: string;
  items: TokenCard[];
  performers: TokenCard[];
  census: { all: number; live: number; running: number; dead: number; early: number };
  matrix: GainMatrix | null;
  band: "early" | "all";
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
  const want = opts.status && opts.status !== "all" ? opts.status : null;
  const band = opts.band === "early" ? "early" : "all";

  const all = await pool.query(
    `${SELECT} WHERE ${WHERE_BUYS}
     ORDER BY t.discovered_at DESC
     LIMIT 5000`,
  );
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

  const performers = [...banded]
    .filter((c) => c.gain_pct != null)
    .sort((a, b) => (b.gain_pct ?? -999) - (a.gain_pct ?? -999))
    .slice(0, 8);

  const census = {
    all: banded.length,
    live: banded.filter((c) => c.status === "live").length,
    running: banded.filter((c) => c.status === "running").length,
    dead: banded.filter((c) => c.status === "dead").length,
    early: earlyN,
  };

  const filtered = want ? banded.filter((c) => c.status === want) : banded;
  const total = filtered.length;
  const items = filtered.slice(offset, offset + limit);

  return {
    at: new Date().toISOString(),
    items,
    performers,
    census,
    matrix: band === "early" ? gainMatrix(banded) : null,
    band,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    total,
    limit,
  };
}

export async function getToken(id: number): Promise<{
  token: TokenCard;
  admissions: Array<{ wallet: string; sig: string | null; at: string; label: string | null }>;
  scans: Array<{ at: string; mc_usd: number | null; liq_usd: number | null; phase: string | null }>;
  memory: DeskMemory[];
} | null> {
  const r = await pool.query(`${SELECT} WHERE t.id = $1 AND ${WHERE_BUYS}`, [id]);
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
      `SELECT at, mc_usd, liq_usd, gain_pct, wallets, status, label, survived
       FROM desk_memory WHERE token_id = $1 ORDER BY at DESC LIMIT 40`,
      [id],
    );
    memory = mem.rows.map((s: {
      at: string | Date;
      mc_usd: number | null;
      liq_usd: number | null;
      gain_pct: number | null;
      wallets: number | null;
      status: string | null;
      label: string | null;
      survived: boolean | null;
    }) => ({
      at: new Date(s.at).toISOString(),
      mc_usd: s.mc_usd != null ? Number(s.mc_usd) : null,
      liq_usd: s.liq_usd != null ? Number(s.liq_usd) : null,
      gain_pct: s.gain_pct != null ? Number(s.gain_pct) : null,
      wallets: s.wallets != null ? Number(s.wallets) : null,
      status: s.status,
      label: s.label,
      survived: s.survived,
    }));
  } catch {
    memory = [];
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
