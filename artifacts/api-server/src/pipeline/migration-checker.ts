/**
 * migration-checker.ts
 *
 * Properly determines whether a Solana token (pump.fun origin) has migrated
 * off its bonding curve and onto Raydium.
 *
 * Sources (tried in order, any positive = migrated):
 *   1. PumpFun API  — `complete: true` on the coin endpoint
 *   2. Helius RPC   — `getAccountInfo` on the bonding curve PDA; reads the
 *                     `complete` boolean at byte offset 48 in the account data
 *   3. DexScreener  — presence of a Raydium pair for the mint
 *
 * Periodic refresh is driven by a BullMQ repeatable job (`migration:check`).
 */

import { createHash } from "crypto";
import { db } from "@workspace/db";
import { tracked_tokens } from "@workspace/db";
import { eq, and, or, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

// ── PumpFun constants ─────────────────────────────────────────────────────────
const PUMP_PROGRAM_B58 = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const BONDING_CURVE_SEED = Buffer.from("bonding-curve");
const COMPLETE_OFFSET = 48;

// ── Base-58 ───────────────────────────────────────────────────────────────────
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) {
    const d = B58_ALPHABET.indexOf(c);
    if (d < 0) throw new Error(`Invalid base58 char: ${c}`);
    n = n * 58n + BigInt(d);
  }
  const hex = n.toString(16).padStart(64, "0");
  const buf = Buffer.from(hex, "hex");
  let leading = 0;
  for (const c of s) { if (c === "1") leading++; else break; }
  return Buffer.concat([Buffer.alloc(leading), buf.slice(buf.findIndex(b => b !== 0))]);
}

// ── ed25519 off-curve check ───────────────────────────────────────────────────
const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function modExp(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp & 1n) result = result * base % mod;
    exp >>= 1n;
    base = base * base % mod;
  }
  return result;
}

function isOnEd25519Curve(hash: Buffer): boolean {
  const ybuf = Buffer.from(hash.slice(0, 32));
  ybuf[31] &= 0x7f;
  const y   = BigInt("0x" + Buffer.from(ybuf).reverse().toString("hex")) % P;
  const y2  = y * y % P;
  const u   = (y2 - 1n + P) % P;
  const v   = (D * y2 % P + 1n) % P;
  const v3  = v * v % P * v % P;
  const v7  = v3 * v3 % P * v % P;
  const x2  = u * v7 % P * modExp(u * modExp(v7, P, P) % P, (P - 5n) / 8n, P) % P;
  const vx2 = v * x2 % P;
  const umod = u % P;
  if (vx2 === umod) return true;
  if ((vx2 + umod) % P === 0n) return true;
  return false;
}

// ── PDA derivation ────────────────────────────────────────────────────────────

function derivePda(seeds: Buffer[], programId: Buffer): Buffer | null {
  const marker = Buffer.from("ProgramDerivedAddress");
  for (let nonce = 255; nonce >= 0; nonce--) {
    const parts = [...seeds, Buffer.from([nonce]), programId, marker];
    const hash = createHash("sha256").update(Buffer.concat(parts)).digest();
    if (!isOnEd25519Curve(hash)) return hash;
  }
  return null;
}

function bondingCurvePda(mintB58: string): string | null {
  try {
    const mintBytes    = base58Decode(mintB58).slice(0, 32);
    const programBytes = base58Decode(PUMP_PROGRAM_B58).slice(0, 32);
    const pda = derivePda([BONDING_CURVE_SEED, mintBytes], programBytes);
    if (!pda) return null;
    let n = BigInt("0x" + pda.toString("hex"));
    let out = "";
    while (n > 0n) { out = B58_ALPHABET[Number(n % 58n)] + out; n /= 58n; }
    return out || "1";
  } catch {
    return null;
  }
}

// ── Source 1: PumpFun API ─────────────────────────────────────────────────────

async function checkPumpFun(mint: string): Promise<boolean | null> {
  try {
    const r = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, {
      signal: AbortSignal.timeout(8_000),
      headers: { Accept: "application/json", "User-Agent": "Crypsor/1.0" },
    });
    if (!r.ok) return null;
    const c = await r.json() as { complete?: boolean };
    return c.complete === true;
  } catch { return null; }
}

// ── Source 2: Helius JSON-RPC ─────────────────────────────────────────────────

async function checkHeliusBondingCurve(mint: string, heliusApiKey: string): Promise<boolean | null> {
  const pdaAddr = bondingCurvePda(mint);
  if (!pdaAddr) return null;
  try {
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [pdaAddr, { encoding: "base64" }] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const json = await r.json() as { result?: { value?: { data?: [string, string] } | null } };
    const data64 = json.result?.value?.data?.[0];
    if (!data64) return null;
    const raw = Buffer.from(data64, "base64");
    if (raw.length <= COMPLETE_OFFSET) return null;
    return raw[COMPLETE_OFFSET] === 1;
  } catch { return null; }
}

// ── Source 3: DexScreener Raydium pair ───────────────────────────────────────

async function checkDexScreenerRaydium(mint: string): Promise<boolean | null> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const json = await r.json() as { pairs?: Array<{ chainId: string; dexId?: string }> };
    const hasRaydium = (json.pairs ?? []).some(p => p.chainId === "solana" && p.dexId === "raydium");
    return hasRaydium || null;
  } catch { return null; }
}

// ── Main check ────────────────────────────────────────────────────────────────

export async function checkMigrationStatus(mint: string, heliusApiKey: string | null): Promise<boolean> {
  const [pf, helius, dex] = await Promise.allSettled([
    checkPumpFun(mint),
    heliusApiKey ? checkHeliusBondingCurve(mint, heliusApiKey) : Promise.resolve(null),
    checkDexScreenerRaydium(mint),
  ]);
  const pfVal     = pf.status     === "fulfilled" ? pf.value     : null;
  const heliusVal = helius.status === "fulfilled" ? helius.value : null;
  const dexVal    = dex.status    === "fulfilled" ? dex.value    : null;
  if (pfVal === true || heliusVal === true || dexVal === true) return true;
  return false;
}

// ── Background refresh ────────────────────────────────────────────────────────

async function getHeliusKey(): Promise<string | null> {
  try {
    const rows = await db.execute(sql`SELECT value FROM settings WHERE key = 'helius_api_key' LIMIT 1`);
    const arr = ((rows as unknown as { rows?: Array<{ value: string }> }).rows ?? rows) as Array<{ value: string }>;
    const dbKey = arr[0]?.value?.trim();
    if (dbKey) return dbKey;
  } catch { /* fall through */ }
  return process.env.HELIUS_API_KEY ?? null;
}

/**
 * Check migration status for all un-migrated Solana tokens.
 * Called by BullMQ pipeline-scheduler every 90 s.
 */
export async function refreshMigrationStatuses(): Promise<void> {
  const tokens = await db
    .select({ id: tracked_tokens.id, address: tracked_tokens.address })
    .from(tracked_tokens)
    .where(and(
      eq(tracked_tokens.chain, "solana"),
      or(eq(tracked_tokens.migrated, false), sql`${tracked_tokens.migrated} IS NULL`),
    ));

  if (!tokens.length) return;

  const heliusKey = await getHeliusKey();
  const BATCH = 5;
  for (let i = 0; i < tokens.length; i += BATCH) {
    const slice = tokens.slice(i, i + BATCH);
    await Promise.allSettled(slice.map(async t => {
      try {
        const migrated = await checkMigrationStatus(t.address, heliusKey);
        if (migrated) {
          await db.update(tracked_tokens).set({ migrated: true }).where(eq(tracked_tokens.id, t.id));
          logger.info({ tokenId: t.id, mint: t.address }, "Token migration confirmed — marked migrated");
        }
      } catch { /* non-fatal */ }
    }));
    if (i + BATCH < tokens.length) await new Promise(r => setTimeout(r, 500));
  }
}

/**
 * Start the migration checker.
 * Periodic refresh runs every 90 s with a 15 s initial delay.
 */
export function startMigrationChecker() {
  const run = () => { refreshMigrationStatuses().catch(err => logger.warn({ err }, "Migration check failed")); };
  setTimeout(() => { run(); setInterval(run, 90_000); }, 15_000);
  logger.info("Migration checker ready (90 s cycle; PumpFun + Helius RPC + DexScreener)");
}
