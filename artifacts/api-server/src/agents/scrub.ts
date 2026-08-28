/**
 * Drop receive-only "buys". Tracked wallets must spend quote/SOL.
 * Soft-kill: phase deceased, wallet_buys 0. No hard delete (FK graph).
 */
import { pool } from "../core/db";
import { isWalletSwapBuy, txsBySigs } from "../sources/helius";
import { agentNote } from "./log";

const BATCH = 60;

type Row = {
  id: number;
  mint: string;
  symbol: string | null;
  source: string;
  wallet_buys: number;
  discovered_at: string | Date | null;
};

type Admit = { token_id: number; wallet: string; sig: string };

export async function scrubReceives(): Promise<{ checked: number; killed: number; cleared: number }> {
  const tokens = await pool.query(
    `SELECT t.id, t.mint, t.symbol, t.source, t.wallet_buys, t.discovered_at
     FROM f2_tokens t
     WHERE COALESCE(t.phase, 'intake') <> 'deceased'
       AND (t.source = 'wallet_buy' OR t.wallet_buys > 0)
     ORDER BY t.id DESC
     LIMIT $1`,
    [BATCH],
  );
  const rows = tokens.rows as Row[];
  if (!rows.length) return { checked: 0, killed: 0, cleared: 0 };

  const ids = rows.map((r) => r.id);
  const adm = await pool.query(
    `SELECT token_id, wallet, sig FROM ward_admissions
     WHERE token_id = ANY($1::int[]) AND sig IS NOT NULL AND sig <> ''`,
    [ids],
  );
  const admits = adm.rows as Admit[];
  const byToken = new Map<number, Admit[]>();
  for (const a of admits) {
    const list = byToken.get(a.token_id) ?? [];
    list.push(a);
    byToken.set(a.token_id, list);
  }

  const sigs = [...new Set(admits.map((a) => a.sig))];
  const txs = await txsBySigs(sigs);

  let killed = 0;
  let cleared = 0;

  for (const row of rows) {
    const list = byToken.get(row.id) ?? [];
    if (list.length === 0) {
      const ageMs = row.discovered_at ? Date.now() - new Date(row.discovered_at).getTime() : 0;
      if (row.source === "wallet_buy" && ageMs > 15 * 60_000) {
        await killReceive(row, "no admission signature");
        killed += 1;
      } else if (row.source !== "wallet_buy" && row.wallet_buys > 0 && ageMs > 15 * 60_000) {
        await clearBuys(row.id);
        cleared += 1;
      }
      continue;
    }
    const fetched = list.filter((a) => txs.has(a.sig));
    if (fetched.length !== list.length) {
      // Incomplete Helius read — do not kill on missing data.
      continue;
    }
    const bought = fetched.some((a) => {
      const tx = txs.get(a.sig);
      return tx ? isWalletSwapBuy(tx, a.wallet, row.mint) : false;
    });
    if (bought) continue;
    if (row.source === "wallet_buy") {
      await killReceive(row, "receive, not a buy");
      killed += 1;
    } else {
      await clearBuys(row.id);
      cleared += 1;
    }
  }

  if (killed || cleared) {
    await agentNote(
      "intake",
      "SCRUB",
      `dropped ${killed} receive-only name(s), cleared ${cleared} fake wallet-buy count(s)`,
      { quiet: true },
    );
  }
  return { checked: rows.length, killed, cleared };
}

async function clearBuys(id: number): Promise<void> {
  await pool.query(`UPDATE f2_tokens SET wallet_buys = 0 WHERE id = $1`, [id]);
}

async function killReceive(row: Row, why: string): Promise<void> {
  await pool.query(
    `UPDATE f2_tokens SET
       phase = 'deceased',
       stage = 'killed',
       kill_reason = 'receive_not_buy',
       wallet_buys = 0,
       hotness = 0,
       deceased_at = COALESCE(deceased_at, NOW())
     WHERE id = $1`,
    [row.id],
  );
  await pool.query(
    `UPDATE ward_trades SET
       status = 'dead',
       closed_at = COALESCE(closed_at, NOW()),
       exit_title = COALESCE(exit_title, 'RECEIVE'),
       exit_body = COALESCE(exit_body, 'Tracked wallet received this mint — not a buy.')
     WHERE token_id = $1 AND status IN ('open','trim')`,
    [row.id],
  );
  const ticker = row.symbol || row.mint.slice(0, 6);
  await agentNote("intake", "SCRUB", `$${ticker} ${why} — removed from desk`, {
    tokenId: row.id, mint: row.mint, quiet: true,
  });
}
