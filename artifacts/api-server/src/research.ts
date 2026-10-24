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
    "Token originality and creator affiliation are UNKNOWN; observed metadata similarity is not proof of origin",
    "Primary social narratives are UNKNOWN; unavailable sources are not FALSE",
    "Manipulation, MEV actor attribution, common funding, and complete holder history are UNKNOWN",
    "No calibrated cohort model or guaranteed return/latency forecast is available",
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
    const freshMarkets = sources.rows.filter(x => /dexscreener|jupiter/i.test(x.provider) && x.source_timestamp && now.getTime()-new Date(x.source_timestamp).getTime() >= -60_000 && now.getTime()-new Date(x.source_timestamp).getTime() <= 300_000);
    const identitySource = sources.rows.find(x => /helius.*(mint|rpc)|solana.*mint/i.test(x.provider) && (x.payload?.value?.data?.parsed?.type === "mint" || x.payload?.result?.value?.data?.parsed?.type === "mint" || x.payload?.type === "mint"));
    const latestMetadata = metadata.rows[0];
    const authoritySourceVerified = Boolean(latestMetadata?.data?.authoritySourceVerified);
    const result = evaluateGate({
      walletCount: wallets.length,eventCount:events.rowCount ?? 0,confirmedCount:events.rows.filter(x=>["confirmed","finalized"].includes(x.commitment)).length,
      hasIdentity:Boolean(identitySource),marketTimestamp:freshMarkets[0]?.source_timestamp ?? null,
      independentMarketSources:new Set(freshMarkets.map(x=>x.provider.toLowerCase().includes("jupiter") ? "jupiter" : "dexscreener")).size,
      mintAuthority:latestMetadata?.mint_authority,freezeAuthority:latestMetadata?.freeze_authority,
      authoritySourceVerified,sourceCount:sources.rowCount ?? 0,holderSnapshots:holders.rowCount ?? 0,
    },now);
    const prior = previous.rows[0];
    const contradictions: Record<string,unknown>[] = [];
    if (prior) {
      if (prior.context?.confidence === "MEDIUM" && result.confidence === "LOW") contradictions.push({decisionId:prior.id,reason:"Current gate cannot reproduce the prior evidence confidence; prior record retained",type:"CONFIDENCE_DOWNGRADE"});
      if (prior.context?.risk && prior.context.risk !== result.risk) contradictions.push({decisionId:prior.id,reason:"Authority/risk evidence changed",before:prior.context.risk,after:result.risk});
    }
    const action = contradictions.length ? "CONTRADICTION" : result.action;
    const thesis = `Hypothesis, not a forecast: ${wallets.length} watched wallet(s) have ${events.rowCount ?? 0} recorded explicit swap output(s) for this mint. This warrants reproducible observation; wallet overlap alone does not establish token quality, coordination, creator affiliation or future returns.`;
    const counterThesis = "Competing hypothesis: the observed swaps may reflect unrelated speculation, short-lived routing or accounts under shared control. Provider parsing may be incomplete. Price and liquidity observations can become stale, and concentrated or authority-controlled supply can invalidate a positive interpretation.";
    const next = new Date(now.getTime()+15*60_000);
    const context = {
      process:["READ","THINK","GATE","JOURNAL","REVISIT"],priority:result.priority,risk:result.risk,confidence:result.confidence,
      sourceWallets:wallets,signatures:[...new Set(events.rows.map(x=>x.signature))],observations:events.rows.map(x=>({id:x.id,signature:x.signature,commitment:x.commitment,observations:x.observations})),
      sourceIds:sources.rows.map(x=>x.id),sourceUrls:sources.rows.map(x=>x.url),
      catalyst:"Recheck after independently confirmed wallet events, new authority/holder evidence, material liquidity change, or new primary-source evidence",
      invalidationTrigger:"Claim unsupported by its source, failed chain confirmation, fresh contradictory evidence, or stale observations",
      nextRecheckTrigger:{at:next.toISOString(),reason:"15 minute evidence freshness and state-change check",minimumMaterialChange:"New event, source timestamp, authority change, or contradictory claim"},
      gaps:[...result.unknowns,...(modelGap?[modelGap]:[])],interpretation:"Deterministic research hypothesis; optional model output is separate and unverified",
      modelHypotheses,modelGap,paidSourceFlags:{social:false,graph:false,archival:false},
    };
    const version = Number(prior?.version ?? 0)+1;
    const decision = await db.query(`INSERT INTO hunter.decision_version(mint,version,action,thesis,counter_thesis,unknowns,evidence_ids,contradictions,gate,reviewer_result,model_version,rule_version,known_at,next_recheck_at,context)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$14,'hunter-rules-v1',$11,$12,$13) RETURNING *`,
      [mint,version,action,thesis,counterThesis,JSON.stringify(result.unknowns),JSON.stringify(evidence.rows.map(x=>x.id)),JSON.stringify(contradictions),result.gate,
        "Deterministic gate completed; independent human/model review pending",now,next,context,modelHypotheses?.model ?? "none"]);
    await db.query("UPDATE hunter.token SET priority=$2,risk=$3,confidence=$4 WHERE mint=$1",[mint,result.priority,result.risk,result.confidence]);
    await db.query(`INSERT INTO hunter.investigation_job(kind,mint,payload,run_after,dedupe_key) VALUES('enrich',$1,$2,$3,$4) ON CONFLICT(dedupe_key) DO NOTHING`,[mint,{reason:"scheduled-revisit",previousDecisionId:decision.rows[0].id},next,`revisit:${mint}:${version}`]);
    await db.query("COMMIT");
    return decision.rows[0];
  } catch(error) { await db.query("ROLLBACK"); throw error; }
  finally {db.release();}
}
