import { pool } from "./store.ts";
import { extractBuys, type Transaction } from "./buys.ts";
export async function ingestTransactions(wallet: string, txs: Transaction[]) {
  const buys = txs
    .flatMap((tx) => extractBuys(tx, wallet))
    .sort((a, b) => a.timestamp - b.timestamp);
  const client = await pool.connect();
  const mints = new Set<string>();
  try {
    await client.query("BEGIN");
    // Serialize ingestion for this wallet, including duplicate webhook deliveries.
    await client.query(
      "SELECT address FROM cw_wallets WHERE address=$1 FOR UPDATE",
      [wallet],
    );
    if (
      !(
        await client.query("SELECT 1 FROM cw_wallets WHERE address=$1", [
          wallet,
        ])
      ).rowCount
    ) {
      await client.query("ROLLBACK");
      return;
    }
    for (const buy of buys) {
      await client.query(
        `INSERT INTO cw_tokens(mint,entry_price,entry_source,entry_at,peak_price,last_buy_at) VALUES($1,$2,$3,to_timestamp($4),$2,to_timestamp($4)) ON CONFLICT(mint) DO NOTHING`,
        [
          buy.mint,
          buy.purchasePrice,
          buy.purchasePrice ? "purchase" : null,
          buy.timestamp,
        ],
      );
      const inserted = await client.query(
        `INSERT INTO cw_buys(wallet,mint,signature,bought_at,purchase_price,parser_version) VALUES($1,$2,$3,to_timestamp($4),$5,'buys-v2') ON CONFLICT DO NOTHING RETURNING signature`,
        [wallet, buy.mint, buy.signature, buy.timestamp, buy.purchasePrice],
      );
      if (!inserted.rowCount) continue;
      const member = await client.query(
        `INSERT INTO cw_token_wallets(mint,wallet,buys,first_buy_at,last_buy_at) VALUES($1,$2,0,to_timestamp($3),to_timestamp($3)) ON CONFLICT DO NOTHING RETURNING mint`,
        [buy.mint, wallet, buy.timestamp],
      );
      await client.query(
        `INSERT INTO cw_wallet_stats(address) VALUES($1) ON CONFLICT DO NOTHING`,
        [wallet],
      );
      await client.query(
        `UPDATE cw_token_wallets SET buys=buys+1,first_buy_at=LEAST(first_buy_at,to_timestamp($3)),last_buy_at=GREATEST(last_buy_at,to_timestamp($3)) WHERE mint=$1 AND wallet=$2`,
        [buy.mint, wallet, buy.timestamp],
      );
      await client.query(
        `UPDATE cw_tokens SET buy_count=buy_count+1,wallet_count=wallet_count+$2,last_buy_at=GREATEST(last_buy_at,to_timestamp($3)),price_due_at=LEAST(price_due_at,now()) WHERE mint=$1`,
        [buy.mint, member.rowCount ? 1 : 0, buy.timestamp],
      );
      await client.query(
        `UPDATE cw_wallet_stats ws SET buys=ws.buys+1,tokens=ws.tokens+$3,priced=ws.priced+$3*(t.gain IS NOT NULL)::int,positive=ws.positive+$3*COALESCE((t.gain>0)::int,0),gain_sum=ws.gain_sum+$3*COALESCE(t.gain,0) FROM cw_tokens t WHERE ws.address=$1 AND t.mint=$2`,
        [wallet, buy.mint, member.rowCount ? 1 : 0],
      );
      const tx = txs.find((tx) => tx.signature === buy.signature);
      if (tx)
        await client.query(
          "INSERT INTO cw_receipts(signature,payload) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [buy.signature, JSON.stringify(tx)],
        );
      mints.add(buy.mint);
    }
    for (const mint of mints)
      await client.query(
        "INSERT INTO cw_jobs(kind,job_key,payload) VALUES('intelligence',$1,$2) ON CONFLICT(job_key) WHERE state IN('queued','running') DO NOTHING",
        [`intelligence:${mint}`, JSON.stringify({ mint })],
      );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
