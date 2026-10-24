import type { Pool } from "pg";

type Json = Record<string, any>;
export type NormalizedObservation = {
  signature: string; instructionPath: string; wallet: string; mint: string | null;
  kind: "WALLET_ACTIVITY" | "SWAP_BUY"; slot: number | null;
  blockTime: string | null; commitment: "provider_reported" | "confirmed" | "finalized";
  observations: Json;
};
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);
const list = (value: unknown): Json[] => Array.isArray(value) ? value.filter(x => x && typeof x === "object") : [];
const positive = (value: unknown) => typeof value === "number" ? Number.isFinite(value) && value > 0 : typeof value === "string" && /^\d+(\.\d+)?$/.test(value) && /[1-9]/.test(value);
const quantity = (output: Json) => output.rawTokenAmount?.tokenAmount ?? output.tokenAmount;

/** Provider-normalized observations, never an independent chain confirmation.
 * A mere inbound transfer is kept as activity, and cannot establish a purchase.
 * Unsupported layouts remain a research gap rather than a fabricated buy.
 */
export function normalizeTransactions(transactions: unknown[], watched: Iterable<string>, trustedCommitment?: "confirmed" | "finalized"): NormalizedObservation[] {
  const wallets = new Set(watched);
  const observations: NormalizedObservation[] = [];
  for (const candidate of transactions) {
    if (!candidate || typeof candidate !== "object") continue;
    const tx = candidate as Json;
    if (typeof tx.signature !== "string" || !SIGNATURE.test(tx.signature)) continue;
    const swap = tx.events?.swap;
    const failed = tx.transactionError != null || tx.meta?.err != null;
    const participants = new Set<string>();
    for (const account of list(tx.accountData)) if (wallets.has(account.account)) participants.add(account.account);
    for (const transfer of [...list(tx.tokenTransfers), ...list(tx.nativeTransfers)]) {
      for (const key of ["fromUserAccount", "toUserAccount", "from", "to"]) if (wallets.has(transfer[key])) participants.add(transfer[key]);
    }
    if (wallets.has(tx.feePayer)) participants.add(tx.feePayer);
    if (swap) {
      for (const input of [swap.nativeInput, ...list(swap.tokenInputs)]) if (input && wallets.has(input.account ?? input.userAccount)) participants.add(input.account ?? input.userAccount);
      for (const output of list(swap.tokenOutputs)) if (wallets.has(output.userAccount)) participants.add(output.userAccount);
    }
    const timestamp = Number(tx.timestamp);
    const blockTime = Number.isFinite(timestamp) && timestamp > 0 && timestamp < 253402300799 ? new Date(timestamp * 1000).toISOString() : null;
    const base = {
      signature: tx.signature, slot: Number.isSafeInteger(tx.slot) && tx.slot >= 0 ? tx.slot : null,
      blockTime, commitment: trustedCommitment ?? "provider_reported" as const,
    };
    for (const wallet of participants) {
      observations.push({ ...base, wallet, mint: null, kind: "WALLET_ACTIVITY", instructionPath: `provider.transaction.wallet:${wallet}`,
        observations: { failed, providerType: typeof tx.type === "string" ? tx.type : null, parser: "hunter-enhanced-v1", purchaseEstablished: false,
          reason: failed ? "Transaction reported failed" : swap ? "Wallet activity observed; only explicit wallet-paid swap outputs establish buys" : "No supported explicit swap evidence; transfer is not a purchase" } });
    }
    if (failed || !swap) continue;
    for (const [index, output] of list(swap.tokenOutputs).entries()) {
      const wallet = output.userAccount;
      if (!wallets.has(wallet) || typeof output.mint !== "string" || !ADDRESS.test(output.mint) || QUOTE_MINTS.has(output.mint) || !positive(quantity(output))) continue;
      const nativePaid = swap.nativeInput?.account === wallet && positive(swap.nativeInput?.amount);
      const inputs = list(swap.tokenInputs).filter(input => input.userAccount === wallet && input.mint !== output.mint && positive(quantity(input)));
      if (!nativePaid && inputs.length === 0) continue;
      // Do not accept a sold mint returned as change as a new token purchase.
      if (list(swap.tokenInputs).some(input => input.userAccount === wallet && input.mint === output.mint && positive(quantity(input)))) continue;
      observations.push({ ...base, wallet, mint: output.mint, kind: "SWAP_BUY", instructionPath: `provider.events.swap.tokenOutputs.${index}.wallet:${wallet}`,
        observations: { parser: "hunter-enhanced-v1", sourcePath: `events.swap.tokenOutputs[${index}]`, rawTokenAmount: output.rawTokenAmount ?? null,
          tokenAmount: output.tokenAmount ?? null, nativePaidLamports: nativePaid ? String(swap.nativeInput.amount) : null,
          inputMints: inputs.map(x => x.mint).filter(Boolean), purchaseEstablished: true,
          verification: trustedCommitment ? `Reconciled ${trustedCommitment} transaction` : "Unverified provider-reported enhanced swap; not independently confirmed" } });
    }
  }
  return observations;
}

export async function ingestTransactions(pool: Pool, transactions: unknown[], options: { source?: string; trustedCommitment?: "confirmed" | "finalized" } = {}) {
  if (!Array.isArray(transactions) || transactions.length > 100) throw new Error("Expected at most 100 transactions");
  const db = await pool.connect();
  let accepted = 0, duplicates = 0, activities = 0;
  try {
    await db.query("BEGIN");
    const state = await db.query("SELECT mode FROM hunter.operator_state WHERE singleton=true FOR SHARE");
    if (state.rows[0]?.mode === "STOP_ALL") { await db.query("ROLLBACK"); return { accepted: 0, duplicates: 0, activities: 0, ignored: transactions.length, stopped: true }; }
    const wallets = await db.query("SELECT address FROM hunter.watched_wallet WHERE active=true");
    const normalized = normalizeTransactions(transactions, wallets.rows.map(w => w.address), options.trustedCommitment);
    for (const event of normalized) {
      if (event.mint) await db.query("INSERT INTO hunter.token(mint) VALUES($1) ON CONFLICT DO NOTHING", [event.mint]);
      const inserted = await db.query(`INSERT INTO hunter.onchain_event(signature,instruction_path,event_kind,wallet_address,mint,slot,block_time,commitment,observations)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(signature,instruction_path,event_kind) DO NOTHING RETURNING id`,
        [event.signature,event.instructionPath,event.kind,event.wallet,event.mint,event.slot,event.blockTime,event.commitment,{...event.observations,source: options.source ?? "helius_webhook"}]);
      if (!inserted.rowCount) {
        duplicates++;
        if (options.trustedCommitment) {
          const upgraded = await db.query(`UPDATE hunter.onchain_event SET commitment=$4
            WHERE signature=$1 AND instruction_path=$2 AND event_kind=$3
            AND (commitment='provider_reported' OR (commitment='confirmed' AND $4='finalized')) RETURNING id`,
            [event.signature,event.instructionPath,event.kind,options.trustedCommitment]);
          if (upgraded.rowCount && event.mint) {
            const confirmation = await db.query(`INSERT INTO hunter.source_document(mint,provider,url,source_timestamp,payload)
              VALUES($1,'helius_rpc_confirmation',$2,now(),$3) RETURNING id`,[event.mint,`https://solscan.io/tx/${event.signature}`,{signature:event.signature,commitment:options.trustedCommitment,eventId:upgraded.rows[0].id,source:options.source ?? "reconciliation"}]);
            await db.query(`INSERT INTO hunter.evidence_claim(mint,source_document_id,claim,status,confidence,data)
              VALUES($1,$2,$3,'OBSERVED','MEDIUM',$4)`,[event.mint,confirmation.rows[0].id,`RPC reconciliation established ${options.trustedCommitment} status for this observed event`,{signature:event.signature,commitment:options.trustedCommitment,eventId:upgraded.rows[0].id}]);
          }
        }
        continue;
      }
      if (!event.mint) { activities++; continue; }
      accepted++;
      const source = await db.query(`INSERT INTO hunter.source_document(mint,provider,url,source_timestamp,payload)
        VALUES($1,$2,$3,$4,$5) RETURNING id`, [event.mint,options.source ?? "helius_webhook",`https://solscan.io/tx/${event.signature}`,event.blockTime,{signature:event.signature,instructionPath:event.instructionPath,...event.observations}]);
      const claim = await db.query(`INSERT INTO hunter.evidence_claim(mint,source_document_id,claim,status,confidence,data)
        VALUES($1,$2,$3,'OBSERVED',$4,$5) RETURNING id`, [event.mint,source.rows[0].id,`Watched wallet ${event.wallet} has an explicit provider-reported token swap output`,event.commitment === "provider_reported" ? "LOW" : "MEDIUM",{wallet:event.wallet,signature:event.signature,eventId:inserted.rows[0].id,commitment:event.commitment}]);
      await db.query(`INSERT INTO hunter.relation_edge(source,target,kind,mint,evidence_ids,data)
        VALUES($1,$2,'OBSERVED_BUY',$2,$3,$4) ON CONFLICT(source,target,kind,mint) DO UPDATE SET last_seen_at=now()`,[event.wallet,event.mint,JSON.stringify([claim.rows[0].id]),{signature:event.signature}]);
      const alertId = `discovery:${event.wallet}:${event.mint}`;
      const alert = await db.query(`INSERT INTO hunter.alert(id,mint,event_id,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,[alertId,event.mint,inserted.rows[0].id,{wallet:event.wallet,signature:event.signature,verification:event.observations.verification,unverified:event.commitment === "provider_reported"}]);
      if (alert.rowCount) await db.query(`INSERT INTO hunter.investigation_job(kind,mint,payload,dedupe_key) VALUES('alert',$1,$2,$3) ON CONFLICT(dedupe_key) DO NOTHING`,[event.mint,{alertId},`alert:${alertId}`]);
      // Enrichment is public factual research, independent of optional AI credits.
      if (state.rows[0]?.mode === "FULL") {
        await db.query(`INSERT INTO hunter.investigation_job(kind,mint,payload,dedupe_key) VALUES('enrich',$1,'{}',$2) ON CONFLICT(dedupe_key) DO NOTHING`,[event.mint,`enrich:${event.mint}:initial`]);
      }
    }
    await db.query("COMMIT");
    return { accepted, duplicates, activities, ignored: Math.max(0, transactions.length - new Set(normalized.map(x=>x.signature)).size), stopped:false };
  } catch(error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}
