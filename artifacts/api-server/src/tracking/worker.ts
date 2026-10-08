import { pool } from "./store.ts";
import { ingestTransactions } from "./ingest.ts";
import type { Transaction } from "./buys.ts";
import { enqueue, type Result } from "../jobs/queue.ts";
import { request, httpsUrl } from "../services/providers.ts";
import { scanDiagnostics } from "./diagnostics.ts";

export async function syncWallet(address: string): Promise<Result> {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return {};
  const wallet = (
    await pool.query("SELECT * FROM cw_wallets WHERE address=$1", [address])
  ).rows[0];
  if (!wallet) return {};
  const target = wallet.catchup_before ? wallet.catchup_target : wallet.cursor;
  let before = wallet.catchup_before as string | null,
    head = wallet.catchup_head as string | null,
    caught = false;
  // Bounded chunks give other wallets a turn. Persist progress and requeue rather than abandon backlogs.
  const maxPages = Number(process.env.WALLET_PAGES_PER_JOB ?? 3);
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(
      `https://api.helius.xyz/v0/addresses/${address}/transactions`,
    );
    url.searchParams.set("api-key", key);
    url.searchParams.set("limit", "100");
    url.searchParams.set("type", "SWAP");
    if (before) url.searchParams.set("before-signature", before);
    const txs = await request<Transaction[]>(
      "helius",
      url.toString(),
      {},
      Number(process.env.HELIUS_RPS ?? 3),
    );
    if (!Array.isArray(txs))
      throw new Error("Unexpected Helius transaction response");
    head ??= txs[0]?.signature ?? null;
    const relevant: Transaction[] = [];
    for (const tx of txs) {
      if (tx.signature === target) {
        caught = true;
        break;
      }
      relevant.push(tx);
    }
    await ingestTransactions(address, relevant);
    await pool.query(
      "UPDATE cw_wallets SET scanned_transactions=scanned_transactions+$2,scanned_swaps=scanned_swaps+$3,last_scan_at=now(),scan_diagnostics=CASE WHEN $2>0 THEN $4::jsonb ELSE scan_diagnostics END WHERE address=$1",
      [
        address,
        relevant.length,
        relevant.filter((tx) => tx.type === "SWAP" && !tx.transactionError)
          .length,
        JSON.stringify(scanDiagnostics(relevant, address)),
      ],
    );
    if (!target || caught || txs.length < 100) {
      await pool.query(
        `UPDATE cw_wallets SET cursor=COALESCE($2,cursor),catchup_before=NULL,catchup_head=NULL,catchup_target=NULL,synced_at=now(),sync_error=NULL,next_sync_at=now()+$3*interval '1 second' WHERE address=$1`,
        [address, head, Number(process.env.WALLET_POLL_SECONDS ?? 30)],
      );
      return {};
    }
    const next = txs.at(-1)?.signature;
    if (!next || next === before)
      throw new Error("Helius pagination made no progress");
    before = next;
    await pool.query(
      "UPDATE cw_wallets SET catchup_before=$2,catchup_head=$3,catchup_target=$4,sync_error=NULL WHERE address=$1",
      [address, before, head, target],
    );
  }
  return { again: true, delayMs: 250 };
}
export function priceInterval(
  token: {
    detected_at: string;
    last_viewed_at?: string | null;
    last_buy_at?: string | null;
  },
  now = Date.now(),
) {
  const age = now - new Date(token.detected_at).getTime();
  if (
    age < 60 * 60_000 ||
    (token.last_viewed_at &&
      now - new Date(token.last_viewed_at).getTime() < 5 * 60_000)
  )
    return 30;
  if (
    token.last_buy_at &&
    now - new Date(token.last_buy_at).getTime() < 24 * 60 * 60_000
  )
    return 90;
  return age < 30 * 24 * 60 * 60_000 ? 900 : 86400;
}
export async function refreshPrices(mints: string[]) {
  const pairs = await request<any[]>(
    "dexscreener",
    `https://api.dexscreener.com/tokens/v1/solana/${mints.join(",")}`,
    {},
    Number(process.env.DEXSCREENER_RPS ?? 2),
  );
  if (!Array.isArray(pairs)) throw new Error("Unexpected DexScreener response");
  for (const mint of mints) {
    const pair = pairs
      .filter(
        (p) =>
          p.chainId === "solana" &&
          p.baseToken?.address === mint &&
          Number(p.priceUsd) > 0 &&
          Number.isFinite(Number(p.priceUsd)),
      )
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const t = (
      await pool.query(
        "SELECT detected_at,last_viewed_at,last_buy_at FROM cw_tokens WHERE mint=$1",
        [mint],
      )
    ).rows[0];
    if (!t) continue;
    const interval = pair ? priceInterval(t) : Math.max(300, priceInterval(t));
    if (!pair) {
      await pool.query(
        "UPDATE cw_tokens SET price_checked_at=now(),price_due_at=now()+$2*interval '1 second' WHERE mint=$1",
        [mint, interval],
      );
      continue;
    }
    const price = Number(pair.priceUsd),
      sample = { price, at: new Date().toISOString() };
    const links = {
      websites: (pair.info?.websites ?? [])
        .map((v: any) => ({
          url: httpsUrl(v.url),
          label: String(v.label ?? "Website").slice(0, 40),
        }))
        .filter((v: any) => v.url),
      socials: (pair.info?.socials ?? [])
        .map((v: any) => ({
          url: httpsUrl(v.url),
          type: String(v.type ?? "Social").slice(0, 30),
        }))
        .filter((v: any) => v.url),
    };
    // A bounded recent history lives with the token; inactive assets keep just six points.
    const keep = interval >= 900 ? 6 : 30;
    await pool.query(
      `UPDATE cw_tokens SET symbol=COALESCE(symbol,$2),name=COALESCE(name,$3),image=COALESCE(image,$4),current_price=$5,entry_price=COALESCE(entry_price,$5),entry_source=COALESCE(entry_source,'detection'),peak_price=GREATEST(COALESCE(peak_price,$5),$5),priced_at=now(),price_checked_at=now(),price_due_at=now()+$6*interval '1 second',history=(SELECT jsonb_agg(v ORDER BY n) FROM(SELECT v,n FROM jsonb_array_elements(cw_tokens.history||$7::jsonb) WITH ORDINALITY e(v,n) ORDER BY n DESC LIMIT $8)s),metadata=metadata||$9::jsonb WHERE mint=$1`,
      [
        mint,
        pair.baseToken.symbol ?? null,
        pair.baseToken.name ?? null,
        httpsUrl(pair.info?.imageUrl),
        price,
        interval,
        JSON.stringify([sample]),
        keep,
        JSON.stringify({
          market: {
            source: "dexscreener",
            at: sample.at,
            pair: httpsUrl(pair.url),
            liquidityUsd: pair.liquidity?.usd ?? null,
            ...links,
          },
        }),
      ],
    );
    await enqueue("intelligence", `intelligence:${mint}`, { mint });
  }
}
export async function enrichMetadata(mint: string) {
  const key = process.env.HELIUS_API_KEY;
  let facts: Record<string, any> = {},
    source = "solana-rpc";
  if (key) {
    const response = await request<any>(
      "helius",
      `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "metadata",
          method: "getAsset",
          params: { id: mint },
        }),
      },
      Number(process.env.HELIUS_RPS ?? 3),
    );
    if (response.result) {
      const a = response.result;
      source = "helius-das";
      facts = {
        name: a.content?.metadata?.name ?? null,
        symbol: a.content?.metadata?.symbol ?? null,
        description: a.content?.metadata?.description ?? null,
        image: httpsUrl(a.content?.links?.image ?? a.content?.files?.[0]?.uri),
        decimals: a.token_info?.decimals ?? null,
        supply:
          a.token_info?.supply != null &&
          (typeof a.token_info.supply === "string" ||
            Number.isSafeInteger(a.token_info.supply))
            ? String(a.token_info.supply)
            : null,
        mintAuthority: a.token_info?.mint_authority ?? null,
        mintAuthorityKnown: Object.hasOwn(a.token_info ?? {}, "mint_authority"),
        freezeAuthority: a.token_info?.freeze_authority ?? null,
        freezeAuthorityKnown: Object.hasOwn(
          a.token_info ?? {},
          "freeze_authority",
        ),
        creators: a.creators ?? [],
        metadataUri: httpsUrl(a.content?.json_uri),
        authorities: a.authorities ?? [],
        tokenProgram: a.token_info?.token_program ?? null,
      };
    }
    // DAS may be unavailable for a mint or plan; on-chain identity has an independent fallback.
  }
  if (
    facts.decimals == null ||
    facts.supply == null ||
    !facts.mintAuthorityKnown ||
    !facts.freezeAuthorityKnown
  ) {
    const response = await request<any>(
      "solana-rpc",
      "https://api.mainnet-beta.solana.com",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "metadata",
          method: "getAccountInfo",
          params: [mint, { encoding: "jsonParsed", commitment: "confirmed" }],
        }),
      },
      Number(process.env.SOLANA_RPC_RPS ?? 1),
    );
    const info = response.result?.value?.data?.parsed?.info;
    if (!info) throw new Error("On-chain token metadata not yet available");
    facts = {
      ...facts,
      decimals: info.decimals,
      supply: String(info.supply),
      mintAuthority: info.mintAuthority ?? null,
      mintAuthorityKnown: Object.hasOwn(info, "mintAuthority"),
      freezeAuthority: info.freezeAuthority ?? null,
      freezeAuthorityKnown: Object.hasOwn(info, "freezeAuthority"),
      tokenProgram: response.result.value.owner,
      onchainSource: "solana-rpc",
    };
  }
  const now = new Date().toISOString();
  await pool.query(
    `UPDATE cw_tokens SET name=COALESCE($2,name),symbol=COALESCE($3,symbol),image=COALESCE($4,image),metadata=metadata||$5::jsonb,metadata_at=now(),metadata_source=$6,metadata_due_at=now()+interval '7 days' WHERE mint=$1`,
    [
      mint,
      facts.name ?? null,
      facts.symbol ?? null,
      facts.image ?? null,
      JSON.stringify({ identity: { ...facts, source, at: now } }),
      source,
    ],
  );
  await enqueue("intelligence", `intelligence:${mint}`, { mint });
}
export async function computeIntelligence(mint: string) {
  const t = (
    await pool.query(
      "SELECT mint,history,wallet_count,buy_count,entry_source,gain,peak_gain,priced_at,metadata_at FROM cw_tokens WHERE mint=$1",
      [mint],
    )
  ).rows[0];
  if (!t) return;
  const samples = t.history as { price: number; at: string }[];
  const oldest = samples[0],
    newest = samples.at(-1);
  const facts = {
    walletOverlap: t.wallet_count,
    totalBuys: Number(t.buy_count),
    entrySource: t.entry_source,
    currentGain: t.gain,
    peakGain: t.peak_gain,
    observedMomentum:
      oldest && newest && oldest.price > 0
        ? (newest.price / oldest.price - 1) * 100
        : null,
    observationStart: oldest?.at ?? null,
    observationEnd: newest?.at ?? null,
    sampleCount: samples.length,
    priceObservedAt: t.priced_at,
    metadataObservedAt: t.metadata_at,
  };
  await pool.query(
    `INSERT INTO cw_insights(mint,version,facts) VALUES($1,'facts-v1',$2) ON CONFLICT(mint) DO UPDATE SET version=EXCLUDED.version,facts=EXCLUDED.facts,computed_at=now()`,
    [mint, JSON.stringify(facts)],
  );
}
