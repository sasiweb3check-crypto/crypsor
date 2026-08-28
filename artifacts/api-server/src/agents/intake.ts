/**
 * INTAKE agent — only data source is tracked-wallet buys (Helius).
 * Each new mint is admitted as a patient. Repeat buys from more wallets
 * raise conviction; a deceased patient can be revived on a fresh buy.
 */
import { pool } from "../core/db";
import { emitSse } from "../core/bus";
import { recentBuys } from "../sources/helius";
import { coin as pumpCoin } from "../sources/pumpfun";
import { agentNote } from "./log";
import { raiseAlert } from "./alerts";

let walletCursor = 0;

export async function intakeTick(): Promise<{ wallets: number; buys: number; admitted: number }> {
  const wr = await pool.query(
    "SELECT address, label FROM walletdatasource WHERE chain = 'solana' ORDER BY id",
  );
  const wallets = wr.rows as Array<{ address: string; label: string | null }>;
  if (!wallets.length) {
    await agentNote("intake", "WAIT", "no tracked wallets in settings");
    return { wallets: 0, buys: 0, admitted: 0 };
  }

  const batch = [
    wallets[walletCursor % wallets.length],
    wallets[(walletCursor + 1) % wallets.length],
  ].filter((v, i, a) => a.findIndex((x) => x.address === v.address) === i);
  walletCursor += 2;

  let buys = 0;
  let admitted = 0;

  for (const w of batch) {
    const found = await recentBuys(w.address, 20);
    for (const b of found) {
      if (Date.now() - b.ts > 8 * 3600_000) continue;
      buys += 1;
      const wasNew = await admit(b.mint, w.address, w.label, b.sig, b.ts);
      if (wasNew) admitted += 1;
    }
  }
  if (admitted) {
    await agentNote("intake", "ADMIT", `admitted ${admitted} patient(s) from ${batch.length} wallet(s)`);
  }
  return { wallets: batch.length, buys, admitted };
}

async function admit(
  mint: string,
  wallet: string,
  label: string | null,
  sig: string,
  ts: number,
): Promise<boolean> {
  const meta = await pumpCoin(mint);
  const mc = meta?.usd_market_cap ?? null;
  const ins = await pool.query(
    `WITH existing AS (
        SELECT id, phase FROM f2_tokens WHERE mint = $1
     ), upsert AS (
        INSERT INTO f2_tokens (
          mint, symbol, name, image, source, created_ts, mc_at_discovery,
          graduated, wallet_buys, stage, phase, admission_mc, last_mc, peak_mc
        ) VALUES ($1,$2,$3,$4,'wallet_buy',$5,$6,$7,1,'tracking','intake',$6,$6,$6)
        ON CONFLICT (mint) DO UPDATE SET
          wallet_buys = f2_tokens.wallet_buys + CASE
            WHEN NOT EXISTS (
              SELECT 1 FROM ward_admissions a
              WHERE a.token_id = f2_tokens.id AND a.wallet = $8
            ) THEN 1 ELSE 0 END,
          symbol = COALESCE(f2_tokens.symbol, EXCLUDED.symbol),
          name = COALESCE(f2_tokens.name, EXCLUDED.name),
          image = COALESCE(f2_tokens.image, EXCLUDED.image),
          phase = CASE
            WHEN f2_tokens.phase = 'deceased' THEN 'revived'
            ELSE f2_tokens.phase END,
          stage = CASE WHEN f2_tokens.stage = 'killed' THEN 'tracking' ELSE f2_tokens.stage END,
          revived_at = CASE WHEN f2_tokens.phase = 'deceased' THEN NOW() ELSE f2_tokens.revived_at END
        RETURNING id, (xmax = 0) AS inserted, phase, symbol, name, wallet_buys, admission_mc
     )
     SELECT u.*, e.phase AS prev_phase
     FROM upsert u
     LEFT JOIN existing e ON e.id = u.id`,
    [
      mint,
      meta?.symbol ?? null,
      meta?.name ?? null,
      meta?.image_uri ?? null,
      meta?.created_timestamp ? new Date(meta.created_timestamp) : new Date(ts),
      mc,
      Boolean(meta?.complete),
      wallet,
    ],
  );
  const row = ins.rows[0] as {
    id: number; inserted: boolean; phase: string; prev_phase: string | null;
    symbol: string | null; name: string | null; wallet_buys: number; admission_mc: number | null;
  } | undefined;
  if (!row?.id) return false;
  await pool.query(
    `INSERT INTO ward_admissions (token_id, wallet, sig, at)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [row.id, wallet, sig, new Date(ts)],
  );

  const ticker = row.symbol || mint.slice(0, 6);
  const who = label || `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;

  if (row.inserted) {
    await agentNote("intake", "ADMIT", `$${ticker} admitted via ${who}`, { tokenId: row.id, mint });
    await raiseAlert({
      tokenId: row.id,
      kind: "admit",
      title: `ADMIT $${ticker}`,
      body: `${who} bought. Patient #${row.id}. MC ${mc != null ? `$${Math.round(mc)}` : "—"}.`,
      payload: { mint, wallet, sig, mc },
      telegram: true,
    });
    emitSse("patient:admit", { id: row.id, mint, symbol: row.symbol });
    return true;
  }

  if (row.prev_phase === "deceased" && row.phase === "revived") {
    await agentNote("intake", "REVIVE", `$${ticker} walked back in via ${who}`, { tokenId: row.id, mint });
    await raiseAlert({
      tokenId: row.id,
      kind: "revived",
      title: `REVIVED $${ticker}`,
      body: `Was deceased. ${who} bought again. ${row.wallet_buys} tracked wallets now.`,
      payload: { mint, wallet },
      telegram: true,
    });
  }
  return false;
}
