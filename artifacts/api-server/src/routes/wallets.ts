import { Router } from "express";
import { db } from "@workspace/db";
import { walletdatasource } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { CreateWalletBody, DeleteWalletParams } from "@workspace/api-zod";

const router = Router();

// GET /api/wallets
router.get("/", async (req, res) => {
  try {
    const rows = await db.select().from(walletdatasource).orderBy(walletdatasource.createdAt);
    res.json(rows.map((r) => ({
      id: r.id,
      address: r.address,
      label: r.label,
      chain: r.chain,
      createdAt: r.createdAt.toISOString(),
    })));
  } catch (err) {
    req.log.error({ err }, "Failed to get wallets");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/wallets
router.post("/", async (req, res) => {
  const parsed = CreateWalletBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const { address, label, chain } = parsed.data;
  const normalizedAddress = address.trim();

  // Check duplicate
  const existing = await db
    .select()
    .from(walletdatasource)
    .where(and(eq(walletdatasource.address, normalizedAddress), eq(walletdatasource.chain, chain)))
    .limit(1);

  if (existing.length > 0) {
    res.status(409).json({ error: "Wallet with this address and chain already exists" });
    return;
  }

  try {
    const [row] = await db
      .insert(walletdatasource)
      .values({ address: normalizedAddress, label, chain })
      .returning();
    res.status(201).json({
      id: row.id,
      address: row.address,
      label: row.label,
      chain: row.chain,
      createdAt: row.createdAt.toISOString(),
    });
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e?.code === "23505") {
      res.status(409).json({ error: "Wallet with this address and chain already exists" });
      return;
    }
    req.log.error({ err }, "Failed to create wallet");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/wallets/:id
router.delete("/:id", async (req, res) => {
  const parsed = DeleteWalletParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const { id } = parsed.data;
  try {
    const deleted = await db
      .delete(walletdatasource)
      .where(eq(walletdatasource.id, id))
      .returning();
    if (deleted.length === 0) {
      res.status(404).json({ error: "Wallet not found" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete wallet");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
