/**
 * INTAKE — tracked-wallet buys only.
 * Detected MC is frozen at the first buy print (Dex, else pump.fun).
 */
import { pool } from "../core/db";
import { emitSse } from "../core/bus";
import { recentBuys } from "../sources/helius";
import { coin as pumpCoin, pumpMc } from "../sources/pumpfun";
import { imageOf, mcOf, pairsForMints } from "../sources/dexscreener";
import { isNoiseToken } from "../scoring/noise";
import { fmtMc, labelOf, statusOf } from "../scoring/desk";
import { httpsImage } from "../scoring/image";
import { agentNote } from "./log";
import { raiseAlert } from "./alerts";
import { insertDeskMemory } from "./memory";

let walletCursor = 0;

export async function intakeTick(): Promise<{ wallets: number; buys: number; admitted: number }> {
  const wr = await pool.query(
    "SELECT address, label FROM walletdatasource WHERE chain = 'solana' ORDER BY id",
  );
  const wallets = wr.rows as Array<{ address: string; label: string | null }>;
  if (!wallets.length) {
    await agentNote("intake", "WAIT", "no tracked wallets in settings", { quiet: true });
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
    const fresh = found.filter((b) => Date.now() - b.ts <= 8 * 3600_000);
    const pairs = await pairsForMints([...new Set(fresh.map((b) => b.mint))]);
    for (const b of fresh) {
      buys += 1;
      const meta = await pumpCoin(b.mint);
      if (isNoiseToken(b.mint, meta?.symbol ?? pairs.get(b.mint)?.baseToken?.symbol)) {
        await agentNote("intake", "SKIP", `noise ${meta?.symbol || b.mint.slice(0, 6)}`, {
          mint: b.mint, quiet: true,
        });
        continue;
      }
      const pair = pairs.get(b.mint);
      const detected = mcOf(pair) ?? pumpMc(meta);
      const image = imageOf(pair) ?? httpsImage(meta?.image_uri);
      const symbol = pair?.baseToken?.symbol ?? meta?.symbol ?? null;
      const name = pair?.baseToken?.name ?? meta?.name ?? null;
      const wasNew = await admit(b.mint, w.address, w.label, b.sig, b.ts, {
        detected, image, symbol, name, created: meta?.created_timestamp, graduated: Boolean(meta?.complete),
      });
      if (wasNew) admitted += 1;
    }
  }
  if (admitted) {
    await agentNote("intake", "ADMIT", `admitted ${admitted} from ${batch.length} wallet(s)`);
  }
  return { wallets: batch.length, buys, admitted };
}

async function admit(
  mint: string,
  wallet: string,
  label: string | null,
  sig: string,
  ts: number,
  meta: {
    detected: number | null;
    image: string | null;
    symbol: string | null;
    name: string | null;
    created?: number;
    graduated: boolean;
  },
): Promise<boolean> {
  const mc = meta.detected;
  const phase = statusOf(mc, mc);
  const ins = await pool.query(
    `WITH existing AS (
        SELECT id, phase, wallet_buys FROM f2_tokens WHERE mint = $1
     ), upsert AS (
        INSERT INTO f2_tokens (
          mint, symbol, name, image, source, created_ts, mc_at_discovery,
          graduated, wallet_buys, stage, phase, admission_mc, detected_mc, last_mc, peak_mc,
          notified_rung
        ) VALUES ($1,$2,$3,$4,'wallet_buy',$5,$6,$7,1,'tracking',$8,$6,$6,$6,$6,1)
        ON CONFLICT (mint) DO UPDATE SET
          wallet_buys = f2_tokens.wallet_buys + CASE
            WHEN NOT EXISTS (
              SELECT 1 FROM ward_admissions a
              WHERE a.token_id = f2_tokens.id AND a.wallet = $9
            ) THEN 1 ELSE 0 END,
          symbol = COALESCE(f2_tokens.symbol, EXCLUDED.symbol),
          name = COALESCE(f2_tokens.name, EXCLUDED.name),
          image = COALESCE(f2_tokens.image, EXCLUDED.image),
          detected_mc = COALESCE(f2_tokens.detected_mc, f2_tokens.admission_mc, EXCLUDED.detected_mc),
          admission_mc = COALESCE(f2_tokens.admission_mc, EXCLUDED.admission_mc),
          phase = CASE
            WHEN f2_tokens.phase = 'dead' OR f2_tokens.phase = 'deceased' THEN EXCLUDED.phase
            ELSE f2_tokens.phase END,
          stage = CASE WHEN f2_tokens.stage = 'killed' THEN 'tracking' ELSE f2_tokens.stage END,
          revived_at = CASE
            WHEN f2_tokens.phase IN ('dead','deceased') THEN NOW()
            ELSE f2_tokens.revived_at END
        RETURNING id, (xmax = 0) AS inserted, phase, symbol, name, wallet_buys,
                  detected_mc, admission_mc, last_mc, last_liq
     )
     SELECT u.*, e.phase AS prev_phase, e.wallet_buys AS prev_buys
     FROM upsert u
     LEFT JOIN existing e ON e.id = u.id`,
    [
      mint,
      meta.symbol,
      meta.name,
      meta.image,
      meta.created ? new Date(meta.created) : new Date(ts),
      mc,
      meta.graduated,
      phase,
      wallet,
    ],
  );
  const row = ins.rows[0] as {
    id: number; inserted: boolean; phase: string; prev_phase: string | null;
    symbol: string | null; name: string | null; wallet_buys: number;
    detected_mc: number | null; admission_mc: number | null; last_mc: number | null;
    last_liq: number | null; prev_buys: number | null;
  } | undefined;
  if (!row?.id) return false;
  await pool.query(
    `INSERT INTO ward_admissions (token_id, wallet, sig, at)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [row.id, wallet, sig, new Date(ts)],
  );

  const ticker = row.symbol || mint.slice(0, 6);
  const who = label || `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
  const detected = row.detected_mc ?? row.admission_mc;
  const nowMc = row.last_mc ?? detected;
  const prevBuys = row.prev_buys ?? 0;
  const extraWallet = !row.inserted && row.wallet_buys > prevBuys;
  if (row.inserted || extraWallet) {
    const deskLabel = labelOf({ lastMc: nowMc, detectedMc: detected, walletBuys: row.wallet_buys });
    try {
      await pool.query(`UPDATE f2_tokens SET desk_label = $2 WHERE id = $1`, [row.id, deskLabel]);
    } catch {
      // desk_label lands after schema pass
    }
    await insertDeskMemory({
      tokenId: row.id,
      mc: nowMc,
      liq: row.last_liq != null ? Number(row.last_liq) : null,
      detected,
      wallets: row.wallet_buys,
    });
  }

  if (row.inserted) {
    await agentNote("intake", "ADMIT", `$${ticker} buy via ${who} @ ${fmtMc(detected)}`, {
      tokenId: row.id, mint,
    });
    await raiseAlert({
      tokenId: row.id,
      kind: "admit",
      title: `BUY $${ticker}`,
      body: `${who} bought. Detected MC ${fmtMc(detected)}.`,
      payload: { mint, wallet, sig, mc: detected },
      telegram: true,
    });
    emitSse("desk:update", { id: row.id, mint, symbol: row.symbol });
    return true;
  }

  if (extraWallet && row.wallet_buys >= 2) {
    await agentNote("intake", "CONFIRM", `$${ticker} wallet ${row.wallet_buys} via ${who}`, {
      tokenId: row.id, mint,
    });
    await raiseAlert({
      tokenId: row.id,
      kind: "confirm",
      title: `${nth(row.wallet_buys)} wallet $${ticker}`,
      body: `${who} bought. ${row.wallet_buys} wallets. Detected ${fmtMc(detected)} · now ${fmtMc(nowMc)}.`,
      payload: { mint, wallet, sig, mc: nowMc, wallets: row.wallet_buys },
      telegram: true,
    });
    emitSse("desk:update", { id: row.id, mint, symbol: row.symbol });
  }
  return false;
}

function nth(n: number): string {
  if (n === 2) return "2nd";
  if (n === 3) return "3rd";
  return `${n}th`;
}
