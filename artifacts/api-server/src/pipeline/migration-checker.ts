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
 * No third-party Solana packages required; PDA derivation uses Node's crypto.
 */

import { createHash } from "crypto";
import { db } from "@workspace/db";
import { tracked_tokens } from "@workspace/db";
import { eq, and, isNull, or, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

// ── PumpFun constants ─────────────────────────────────────────────────────────
// Program ID for pump.fun's bonding curve program (mainnet)
const PUMP_PROGRAM_B58 = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const BONDING_CURVE_SEED = Buffer.from("bonding-curve");
// Offset of the `complete` bool inside the BondingCurve account data
// Layout: 8-byte discriminator + 5×u64 (5×8=40 bytes) → complete at 48
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
  // Convert bigint → bytes
  const hex = n.toString(16).padStart(64, "0");
  const buf = Buffer.from(hex, "hex");
  // Leading 1s in base58 → leading 0x00 bytes
  let leading = 0;
  for (const c of s) { if (c === "1") leading++; else break; }
  return Buffer.concat([Buffer.alloc(leading), buf.slice(buf.findIndex(b => b !== 0))]);
}

// ── ed25519 off-curve check (BigInt) ──────────────────────────────────────────
// PDAs must be off the ed25519 curve.
// We check: does y (from hash bytes) yield a valid x²? If yes → on curve.

const P = (1n << 255n) - 19n;          // Field prime 2^255 - 19
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

/** Returns true if the 32-byte hash represents a point ON the ed25519 curve. */
function isOnEd25519Curve(hash: Buffer): boolean {
  // Read y from bytes (little-endian, clear sign bit)
  const ybuf = Buffer.from(hash.slice(0, 32));
  ybuf[31] &= 0x7f;
  const y = BigInt("0x" + Buffer.from(ybuf).reverse().toString("hex")) % P;

  const y2   = y * y % P;
  const u    = (y2 - 1n + P) % P;
  const v    = (D * y2 % P + 1n) % P;
  const v3   = v * v % P * v % P;
  const v7   = v3 * v3 % P * v % P;
  const x2   = u * v7 % P * modExp(u * modExp(v7, P, P) % P, (P - 5n) / 8n, P) % P;

  // Check if x2 == u/v (i.e., point is valid)
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
    // Encode PDA as base58
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
  } catch {
    return null;
  }
}

// ── Source 2: Helius JSON-RPC getAccountInfo on bonding curve PDA ─────────────

async function checkHelíusBondingCurve(
  mint: string,
  heliusApiKey: string,
): Promise<boolean | null> {
  const pdaAddr = bondingCurvePda(mint);
  if (!pdaAddr) return null;

  try {
    const rpc = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
    const body = {
      jsonrpc: "2.0", id: 1,
      method: "getAccountInfo",
      params: [pdaAddr, { encoding: "base64" }],
    };
    const r = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const json = await r.json() as {
      result?: { value?: { data?: [string, string] } | null };
    };
    const data64 = json.result?.value?.data?.[0];
    if (!data64) return null; // account doesn't exist — null result

    const raw = Buffer.from(data64, "base64");
    if (raw.length <= COMPLETE_OFFSET) return null;
    return raw[COMPLETE_OFFSET] === 1;
  } catch {
    return null;
  }
}

// ── Source 3: DexScreener Raydium pair check ──────────────────────────────────

async function checkDexScreenerRaydium(mint: string): Promise<boolean | null> {
  try {
    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!r.ok) return null;
    const json = await r.json() as {
      pairs?: Array<{ chainId: string; dexId?: string }>;
    };
    const hasRaydium = (json.pairs ?? []).some(
      p => p.chainId === "solana" && p.dexId === "raydium",
    );
    return hasRaydium || null; // null = "not found, don't conclude"
  } catch {
    return null;
  }
}

// ── Main check ────────────────────────────────────────────────────────────────

export async function checkMigrationStatus(
  mint: string,
  heliusApiKey: string | null,
): Promise<boolean> {
  // Run all sources concurrently, take first definitive positive answer
  const [pf, helius, dex] = await Promise.allSettled([
    checkPumpFun(mint),
    heliusApiKey ? checkHelíusBondingCurve(mint, heliusApiKey) : Promise.resolve(null),
    checkDexScreenerRaydium(mint),
  ]);

  const pfVal     = pf.status     === "fulfilled" ? pf.value     : null;
  const heliusVal = helius.status === "fulfilled" ? helius.value : null;
  const dexVal    = dex.status    === "fulfilled" ? dex.value    : null;

  // Any source confirming migration → migrated
  if (pfVal === true || heliusVal === true || dexVal === true) return true;
  // All sources answered definitively "no" → not migrated
  return false;
}

// ── Background refresh loop ───────────────────────────────────────────────────

async function getHeliusKey(): Promise<string | null> {
  try {
    const rows = await db.execute(sql`SELECT value FROM settings WHERE key = 'helius_api_key' LIMIT 1`);
    const arr = ((rows as unknown as { rows?: Array<{ value: string }> }).rows ?? rows) as Array<{ value: string }>;
    const dbKey = arr[0]?.value?.trim();
    if (dbKey) return dbKey;
  } catch { /* fall through */ }
  return process.env.HELIUS_API_KEY ?? null;
}

async function refreshMigrationStatuses(): Promise<void> {
  // Only check Solana tokens that are not yet marked migrated
  const tokens = await db
    .select({ id: tracked_tokens.id, address: tracked_tokens.address })
    .from(tracked_tokens)
    .where(
      and(
        eq(tracked_tokens.chain, "solana"),
        or(
          eq(tracked_tokens.migrated, false),
          sql`${tracked_tokens.migrated} IS NULL`,
        ),
      ),
    );

  if (!tokens.length) return;

  const heliusKey = await getHeliusKey();

  // Check in small batches to avoid rate-limiting
  const BATCH = 5;
  for (let i = 0; i < tokens.length; i += BATCH) {
    const slice = tokens.slice(i, i + BATCH);
    await Promise.allSettled(slice.map(async t => {
      try {
        const migrated = await checkMigrationStatus(t.address, heliusKey);
        if (migrated) {
          await db.update(tracked_tokens)
            .set({ migrated: true })
            .where(eq(tracked_tokens.id, t.id));
          logger.info({ tokenId: t.id, mint: t.address }, "Token migration confirmed — marked migrated");
        }
      } catch { /* non-fatal */ }
    }));
    if (i + BATCH < tokens.length) {
      await new Promise(r => setTimeout(r, 500)); // gentle throttle
    }
  }
}

const INTERVAL_MS = 90_000; // check every 90 seconds

export function startMigrationChecker() {
  const loop = () => {
    refreshMigrationStatuses()
      .catch(err => logger.warn({ err }, "Migration check cycle failed"))
      .finally(() => setTimeout(loop, INTERVAL_MS));
  };
  setTimeout(loop, 15_000); // initial delay after server start
  logger.info("Migration checker started (90s cycle; PumpFun + Helius RPC + DexScreener)");
}
