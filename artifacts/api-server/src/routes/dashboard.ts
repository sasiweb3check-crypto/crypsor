import { Router } from "express";
import { db } from "@workspace/db";
import { tracked_tokens, token_buys, token_holders } from "@workspace/db";
import { count, desc, eq, gt, sql } from "drizzle-orm";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const [
      totalTokens,
      totalBuys,
      hotCount,
      lifecycleRows,
      archivedRows,
      kolWallets,
      smartWallets,
    ] = await Promise.all([
      db.select({ c: count() }).from(tracked_tokens),
      db.select({ c: count() }).from(token_buys),
      db.select({ c: count() }).from(tracked_tokens).where(gt(tracked_tokens.holderMomentumScore, 8)),
      db.select({ status: tracked_tokens.status, c: count() })
        .from(tracked_tokens)
        .groupBy(tracked_tokens.status),
      db.select({ c: count() }).from(tracked_tokens).where(eq(tracked_tokens.status, "archive")),
      // Deduplicated KOL wallet count across ALL tokens
      db.execute(sql`
        SELECT COUNT(DISTINCT wallet_address)::text AS c
        FROM token_holders
        WHERE labels && ARRAY['kol','renowned']::text[]
      `),
      // Deduplicated Smart wallet count across ALL tokens
      db.execute(sql`
        SELECT COUNT(DISTINCT wallet_address)::text AS c
        FROM token_holders
        WHERE labels && ARRAY['smart_money','smart_degen']::text[]
      `),
    ]);

    const lifecycle: Record<string, number> = {};
    for (const row of lifecycleRows) {
      lifecycle[row.status] = Number(row.c);
    }

    // Top tokens by holder accumulation score.
    const trending = await db
      .select({
        id:              tracked_tokens.id,
        name:            tracked_tokens.name,
        symbol:          tracked_tokens.symbol,
        logoUri:         tracked_tokens.logoUri,
        currentPriceUsd: tracked_tokens.currentPriceUsd,
        marketCapUsd:    tracked_tokens.marketCapUsd,
         holderMomentumScore: tracked_tokens.holderMomentumScore,
         holderMomentumLabel: tracked_tokens.holderMomentumLabel,
         holderCount:      tracked_tokens.holderCount,
         holderKolCount:   tracked_tokens.holderKolCount,
         holderSmartCount: tracked_tokens.holderSmartCount,
        status:          tracked_tokens.status,
        chain:           tracked_tokens.chain,
      })
      .from(tracked_tokens)
      .orderBy(desc(tracked_tokens.holderMomentumScore), desc(tracked_tokens.holderCount))
      .limit(5);

    // Extract deduplicated KOL / Smart counts
    type CountRow = { c: string };
    const kolRows   = ((kolWallets   as unknown as { rows?: CountRow[] }).rows ?? kolWallets   as unknown as CountRow[]);
    const smartRows = ((smartWallets as unknown as { rows?: CountRow[] }).rows ?? smartWallets as unknown as CountRow[]);

    res.json({
      totalTokens:     Number(totalTokens[0]?.c  ?? 0),
      totalBuys:       Number(totalBuys[0]?.c    ?? 0),
      hotCount:        Number(hotCount[0]?.c     ?? 0),
      archivedCount:   Number(archivedRows[0]?.c ?? 0),
      // Deduplicated across ALL tracked tokens — same wallet in N tokens counts once
      totalKolWallets:   Number(kolRows[0]?.c   ?? 0),
      totalSmartWallets: Number(smartRows[0]?.c ?? 0),
      lifecycle,
      trending,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
