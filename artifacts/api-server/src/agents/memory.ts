/**
 * Thin desk memory — one snapshot per scan print.
 * Labels never hide a name from the book. No scoring, no omo, no ATH oracle.
 */
import { pool } from "../core/db";
import { gainPct, labelOf, statusOf, survives, type DeskLabel } from "../scoring/desk";

export function deskStamp(opts: {
  lastMc: number | null | undefined;
  detectedMc: number | null | undefined;
  walletBuys: number;
}): { label: DeskLabel; status: ReturnType<typeof statusOf>; survived: boolean; gain: number | null } {
  const last = opts.lastMc ?? null;
  const det = opts.detectedMc ?? null;
  return {
    label: labelOf({ lastMc: last, detectedMc: det, walletBuys: opts.walletBuys }),
    status: statusOf(last, det),
    survived: survives(last, det),
    gain: gainPct(last, det),
  };
}

export async function insertDeskMemory(opts: {
  tokenId: number;
  mc: number | null;
  liq: number | null;
  detected: number | null;
  wallets: number;
}): Promise<DeskLabel> {
  const stamp = deskStamp({ lastMc: opts.mc, detectedMc: opts.detected, walletBuys: opts.wallets });
  try {
    await pool.query(
      `INSERT INTO desk_memory
         (token_id, mc_usd, liq_usd, detected_mc, gain_pct, wallets, status, label, survived)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        opts.tokenId,
        opts.mc,
        opts.liq,
        opts.detected,
        stamp.gain,
        opts.wallets,
        stamp.status,
        stamp.label,
        stamp.survived,
      ],
    );
  } catch {
    // table appears after schema pass
  }
  return stamp.label;
}
