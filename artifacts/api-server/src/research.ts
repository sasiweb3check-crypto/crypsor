import {createHash} from 'node:crypto';
import type { Pool } from "pg";
import { geminiHypotheses, type ProviderConfig } from "./providers.ts";

type Facts = {
  walletCount: number; eventCount: number; confirmedCount: number;
  hasIdentity: boolean; marketTimestamp: string | Date | null;
  independentMarketSources: number; mintAuthority: string | null | undefined;
  freezeAuthority: string | null | undefined; authoritySourceVerified: boolean;
  sourceCount: number; holderSnapshots: number;
};
export function evaluateGate(facts: Facts, at = new Date()) {
  const marketAgeMs = facts.marketTimestamp ? at.getTime() - new Date(facts.marketTimestamp).getTime() : null;
  const marketFresh = marketAgeMs !== null && marketAgeMs >= -60_000 && marketAgeMs <= 5 * 60_000;
  const identity = facts.hasIdentity;
  const provenance = facts.sourceCount > 0 && facts.eventCount > 0;
  const confirmed = facts.confirmedCount > 0;
  const independentMarkets = facts.independentMarketSources >= 2;
  const riskyAuthorities = facts.authoritySourceVerified && Boolean(facts.mintAuthority || facts.freezeAuthority);
  const unknowns = [
    ...(!identity ? ["Mint identity has not been independently resolved on chain"] : []),
    ...(!confirmed ? ["Provider-reported swap has not been independently reconciled as confirmed/finalized"] : []),
    ...(!marketFresh ? ["Current price and liquidity evidence is unavailable or older than five minutes"] : []),
    ...(!independentMarkets ? ["Independent market-source cross-check is incomplete"] : []),
    ...(!facts.authoritySourceVerified ? ["Mint/freeze authority state is UNKNOWN"] : []),
    ...(facts.holderSnapshots === 0 ? ["Holder ownership and concentration have not been measured"] : []),
  ];
  const confidence = provenance && confirmed && identity && marketFresh && independentMarkets ? "MEDIUM" : "LOW";
  const priority = facts.walletCount >= 3 ? "HIGH" : facts.walletCount >= 2 ? "MEDIUM" : "LOW";
  const risk = riskyAuthorities ? "ELEVATED" : facts.authoritySourceVerified ? "UNASSESSED" : "UNKNOWN";
  return {
    action: provenance && confirmed && identity && marketFresh ? "WATCH" : "INSUFFICIENT_EVIDENCE",
    priority, risk, confidence, unknowns,
    gate: { provenance, independentChainConfirmation: confirmed, mintIdentity: identity, marketFresh, marketAgeMs, independentMarkets,
      authoritySourceVerified: facts.authoritySourceVerified, riskyAuthorities, paidWorkEligible: false,
      result: "Rules only; research signals never authorize a trade", checkedAt: at.toISOString() },
  };
}

/** Append a reproducible, rule-based decision. No external calls or LLM output
 * are needed to keep facts and unknowns visible when free AI is unavailable.
 */
export async function researchToken(pool: Pool, mint: string, config: ProviderConfig = process.env) {
  let modelHypotheses: Record<string,unknown> | null = null;
  let modelGap: string | null = null;
  // Optional network work occurs before opening the journal transaction. It is
  // independently capped, and can never hold the small database pool hostage.
  if(config.GEMINI_ENABLED === "true") {
    const mode = (await pool.query("SELECT mode FROM hunter.operator_state WHERE singleton=true")).rows[0]?.mode;
    if(mode === "FULL") {
      const publicEvidence = (await pool.query("SELECT id,claim,status,confidence FROM hunter.evidence_claim WHERE mint=$1 ORDER BY known_at DESC LIMIT 20",[mint])).rows;
      try {
        const response = await geminiHypotheses(pool,mint,{mint,evidence:publicEvidence},config);
        if(response) {
          const raw = response.untrusted_hypotheses;
          const permitted = new Set(publicEvidence.map(e=>String(e.id)));
          const cited = Array.isArray(raw?.cited_evidence_ids) ? raw.cited_evidence_ids.map(String) : [];
          if(!raw || typeof raw.thesis !== "string" || typeof raw.counter_thesis !== "string" || cited.some((id:string)=>!permitted.has(id))) {
            modelGap="AI output failed schema/citation validation; no model assertion accepted";
          } else {
            modelHypotheses={model:response.model,thesis:raw.thesis.slice(0,4000),counter_thesis:raw.counter_thesis.slice(0,4000),
              unknowns:Array.isArray(raw.unknowns)?raw.unknowns.filter((x:unknown)=>typeof x==="string").slice(0,20):[],
              invalidation_trigger:typeof raw.invalidation_trigger==="string"?raw.invalidation_trigger.slice(0,2000):"UNKNOWN",
              cited_evidence_ids:cited,reviewer_result:"MODEL_OUTPUT_UNVERIFIED",classification:"Unverified model hypotheses; never gate evidence"};
          }
        } else modelGap="Optional AI disabled or free-tier entitlement not confirmed";
      } catch { modelGap="Optional AI unavailable, quota exhausted, or request failed; deterministic dossier retained"; }
    }
  }
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const state = await db.query("SELECT mode FROM hunter.operator_state WHERE singleton=true FOR SHARE");
    if (state.rows[0]?.mode !== "FULL") { await db.query("ROLLBACK"); return { skipped: true, reason: `Operator mode ${state.rows[0]?.mode ?? 'UNKNOWN'} forbids new research` }; }
    // One writer per mint; versions and their source snapshots must be atomic.
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`hunter-decision:${mint}`]);
    const tokenResult = await db.query("SELECT * FROM hunter.token WHERE mint=$1 FOR UPDATE",[mint]);
    if (!tokenResult.rowCount) throw new Error("Unknown token");
    const token = tokenResult.rows[0];
    const reads = [
      () => db.query("SELECT * FROM hunter.onchain_event WHERE mint=$1 ORDER BY observed_at DESC LIMIT 100",[mint]),
      () => db.query("SELECT id,provider,url,source_timestamp,fetched_at,payload FROM hunter.source_document WHERE mint=$1 ORDER BY fetched_at DESC LIMIT 100",[mint]),
      () => db.query("SELECT * FROM hunter.evidence_claim WHERE mint=$1 ORDER BY known_at DESC LIMIT 100",[mint]),
      () => db.query("SELECT * FROM hunter.token_metadata_version WHERE mint=$1 AND data->>'authoritySourceVerified'='true' ORDER BY observed_at DESC LIMIT 1",[mint]),
      () => db.query("SELECT * FROM hunter.holder_snapshot WHERE mint=$1 ORDER BY captured_at DESC LIMIT 2",[mint]),
      () => db.query("SELECT * FROM hunter.decision_version WHERE mint=$1 ORDER BY version DESC LIMIT 1",[mint]),
    ];
    const results = [];
    for (const read of reads) results.push(await read());
    const [events, sources, evidence, metadata, holders, previous] = results;
    const now = new Date();
    const wallets = [...new Set(events.rows.map(x=>x.wallet_address))];
    const freshMarkets = sources.rows.filter(x => /dexscreener|jupiter|geckoterminal/i.test(x.provider) && x.fetched_at && now.getTime()-new Date(x.fetched_at).getTime() >= -60_000 && now.getTime()-new Date(x.fetched_at).getTime() <= 300_000);
    const identitySource = sources.rows.find(x => /helius.*(mint|rpc)|solana.*mint/i.test(x.provider) && (x.payload?.value?.data?.parsed?.type === "mint" || x.payload?.result?.value?.data?.parsed?.type === "mint" || x.payload?.type === "mint"));
    const latestMetadata = metadata.rows[0];
    const authoritySourceVerified = Boolean(latestMetadata?.data?.authoritySourceVerified);
    const result = evaluateGate({
      walletCount: wallets.length,eventCount:events.rowCount ?? 0,confirmedCount:events.rows.filter(x=>["confirmed","finalized"].includes(x.commitment)).length,
      hasIdentity:Boolean(identitySource),marketTimestamp:freshMarkets[0]?.fetched_at ?? null,
      independentMarketSources:new Set(freshMarkets.map(x=>x.provider.toLowerCase())).size,
      mintAuthority:latestMetadata?.mint_authority,freezeAuthority:latestMetadata?.freeze_authority,
      authoritySourceVerified,sourceCount:sources.rowCount ?? 0,holderSnapshots:holders.rowCount ?? 0,
    },now);
    if(freshMarkets.some(source=>!source.source_timestamp))result.unknowns.push("Market freshness measures retrieval time; provider update time is unavailable for some sources and latency is not verified");
    result.gate.result="Retrieval freshness checked separately from provider update timestamps; rules never authorize trades";
    const prior = previous.rows[0];
    const contradictions: Record<string,unknown>[] = [];
    if (prior) {
      if (prior.context?.confidence === "MEDIUM" && result.confidence === "LOW") contradictions.push({decisionId:prior.id,reason:"Current gate cannot reproduce the prior evidence confidence; prior record retained",type:"CONFIDENCE_DOWNGRADE"});
      if (prior.context?.risk && prior.context.risk !== result.risk) contradictions.push({decisionId:prior.id,reason:"Authority/risk evidence changed",before:prior.context.risk,after:result.risk});
    }
    const action = contradictions.length ? "CONTRADICTION" : result.action;
    const evidenceSummary = [
      `In the latest ${events.rowCount??0} recorded swap output${events.rowCount===1?'':'s'}, ${wallets.length} watched wallet${wallets.length===1?' is':'s are'} represented.`,
      `${events.rows.filter(x=>['confirmed','finalized'].includes(x.commitment)).length} output(s) reconciled against confirmed/finalized signatures.`,
      token.price_usd!==null?`Last market observation: $${token.price_usd} per token; liquidity ${token.liquidity_usd===null?'not returned':'$'+token.liquidity_usd}.`:'No market price was returned.',
      authoritySourceVerified?`Mint authority ${latestMetadata.mint_authority===null?'revoked':'present'}; freeze authority ${latestMetadata.freeze_authority===null?'revoked':'present'}.`:'Mint/freeze authority checks remain incomplete.'
    ];
    const thesis = evidenceSummary.join(' ');
    const counterThesis = result.gate.riskyAuthorities?'An active mint or freeze authority requires review. Authority presence alone does not prove malicious use.':!result.gate.independentChainConfirmation?'The swap evidence remains provider-reported; do not treat it as independent chain confirmation.':result.gate.independentMarkets?'Two market APIs were retrieved, but may report the same underlying venues. Cross-source agreement is not a return forecast.':'Only one market provider is available. Price has no independent cross-check; wallet overlap does not establish token quality.';
    const fingerprint=createHash('sha256').update(JSON.stringify({events:events.rows.map(e=>[e.id,e.commitment]),price:token.price_usd,liquidity:token.liquidity_usd,authorities:latestMetadata?[latestMetadata.mint_authority,latestMetadata.freeze_authority]:null,holders:holders.rows[0]?.features,action,confidence:result.confidence,risk:result.risk,gaps:result.unknowns,modelHypotheses})).digest('hex');
    const next = new Date(now.getTime()+60*60_000);
    if(prior?.context?.evidenceFingerprint===fingerprint){
      await db.query(`INSERT INTO hunter.investigation_job(kind,mint,payload,run_after,dedupe_key) VALUES('enrich',$1,$2,$3,$4) ON CONFLICT(dedupe_key) DO NOTHING`,[mint,{reason:'unchanged-evidence-revisit'},next,`revisit-unchanged:${mint}:${Math.floor(next.getTime()/3600000)}`]);
      await db.query('COMMIT');return {...prior,unchanged:true};
    }
    const context = {
      evidenceFingerprint:fingerprint,evidenceSummary,classification:"Rule-based observation summary, not an AI thesis or trade signal",
      process:["READ","THINK","GATE","JOURNAL","REVISIT"],priority:result.priority,risk:result.risk,confidence:result.confidence,
      sourceWallets:wallets,signatures:[...new Set(events.rows.map(x=>x.signature))],observations:events.rows.map(x=>({id:x.id,signature:x.signature,commitment:x.commitment,observations:x.observations})),
      sourceIds:sources.rows.map(x=>x.id),sourceUrls:sources.rows.map(x=>x.url),
      catalyst:"Recheck after independently confirmed wallet events, new authority/holder evidence, material liquidity change, or new primary-source evidence",
      invalidationTrigger:"Claim unsupported by its source, failed chain confirmation, fresh contradictory evidence, or stale observations",
      nextRecheckTrigger:{at:next.toISOString(),reason:"Hourly evidence review within provider budget",minimumMaterialChange:"New event, source timestamp, authority change, or contradictory claim"},
      gaps:[...result.unknowns,...(modelGap?[modelGap]:[])],interpretation:"Deterministic research hypothesis; optional model output is separate and unverified",
      modelHypotheses,modelGap,paidSourceFlags:{social:false,graph:false,archival:false},
    };
    const version = Number(prior?.version ?? 0)+1;
    const decision = await db.query(`INSERT INTO hunter.decision_version(mint,version,action,thesis,counter_thesis,unknowns,evidence_ids,contradictions,gate,reviewer_result,model_version,rule_version,known_at,next_recheck_at,context)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$14,'hunter-facts-v2',$11,$12,$13) RETURNING *`,
      [mint,version,action,thesis,counterThesis,JSON.stringify(result.unknowns),JSON.stringify(evidence.rows.map(x=>x.id)),JSON.stringify(contradictions),result.gate,
        "Deterministic gate completed; independent human/model review pending",now,next,context,modelHypotheses?.model ?? "none"]);
    await db.query("UPDATE hunter.token SET priority=$2,risk=$3,confidence=$4 WHERE mint=$1",[mint,result.priority,result.risk,result.confidence]);
    await db.query(`INSERT INTO hunter.investigation_job(kind,mint,payload,run_after,dedupe_key) VALUES('enrich',$1,$2,$3,$4) ON CONFLICT(dedupe_key) DO NOTHING`,[mint,{reason:"scheduled-revisit",previousDecisionId:decision.rows[0].id},next,`revisit:${mint}:${version}`]);
    await db.query("COMMIT");
    return decision.rows[0];
  } catch(error) { await db.query("ROLLBACK"); throw error; }
  finally {db.release();}
}
