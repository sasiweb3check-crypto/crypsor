import { Router } from "express";
import { db } from "@workspace/db";
import { settings } from "@workspace/db";
import { eq } from "drizzle-orm";
import { UpsertSettingBody } from "@workspace/api-zod";

const router = Router();

// GET /api/settings
router.get("/", async (req, res) => {
  try {
    const rows = await db.select().from(settings).orderBy(settings.key);
    res.json(rows.map((r) => ({
      id: r.id,
      key: r.key,
      value: r.value,
      updatedAt: r.updatedAt.toISOString(),
    })));
  } catch (err) {
    req.log.error({ err }, "Failed to get settings");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /api/settings
router.put("/", async (req, res) => {
  const parsed = UpsertSettingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const { key, value } = parsed.data;
  try {
    const [row] = await db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
      .returning();
    res.json({
      id: row.id,
      key: row.key,
      value: row.value,
      updatedAt: row.updatedAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to upsert setting");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
