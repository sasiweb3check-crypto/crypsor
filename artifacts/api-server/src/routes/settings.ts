import { Router } from "express";
import { db } from "@workspace/db";
import { settings } from "@workspace/db";
import { eq } from "drizzle-orm";
import { UpsertSettingBody } from "@workspace/api-zod";
import { invalidateTelegramPushCache } from "../lib/telegram-push";
import { apiFail, apiOk } from "../lib/api-envelope";
import { monitorStatus } from "../lib/monitor";

const router = Router();

async function resolveHeliusKey(): Promise<string | null> {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "helius_api_key"))
    .limit(1);
  return rows[0]?.value?.trim() || process.env.HELIUS_API_KEY?.trim() || null;
}

async function resolveHeliusProjectId(): Promise<string | null> {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "helius_project_id"))
    .limit(1);
  return rows[0]?.value?.trim() || process.env.HELIUS_PROJECT_ID?.trim() || null;
}

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
  const { key } = parsed.data;
  // Trim Telegram / Helius credentials — whitespace caused false config failures
  const trimKeys = new Set([
    "telegram_bot_token",
    "telegram_chat_id",
    "helius_api_key",
    "helius_project_id",
    "telegram_push_enabled",
  ]);
  const value =
    typeof parsed.data.value === "string" && trimKeys.has(key)
      ? parsed.data.value.trim()
      : parsed.data.value;
  try {
    const [row] = await db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
      .returning();
    if (key === "telegram_push_enabled") {
      invalidateTelegramPushCache();
    }
    if (key === "helius_api_key") {
      monitorStatus.heliusConfigured = Boolean(value);
      monitorStatus.heliusLastError = null;
    }
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

/**
 * GET /api/settings/helius-usage
 * Verify Helius API key (RPC ping) and, when project id is saved, fetch credit limit.
 */
router.get("/helius-usage", async (req, res) => {
  try {
    const key = await resolveHeliusKey();
    if (!key) {
      res.status(400).json(apiFail("Helius API key not configured", "helius_no_key"));
      return;
    }

    const t0 = Date.now();
    let rpcOk = false;
    let rpcError: string | null = null;
    let slot: number | null = null;
    try {
      const rpcResp = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await rpcResp.json() as { result?: number; error?: { message?: string } };
      if (rpcResp.ok && body.result != null) {
        rpcOk = true;
        slot = Number(body.result);
      } else {
        rpcError = body.error?.message || `HTTP ${rpcResp.status}`;
      }
    } catch (err) {
      rpcError = err instanceof Error ? err.message : String(err);
    }
    const rpcLatencyMs = Date.now() - t0;

    const projectId = await resolveHeliusProjectId();
    let usage: {
      creditsRemaining: number | null;
      creditsUsed: number | null;
      creditsLimit: number | null;
      plan: string | null;
      cycleStart: string | null;
      cycleEnd: string | null;
      prepaidCreditsRemaining: number | null;
    } | null = null;
    let usageError: string | null = null;

    if (projectId) {
      try {
        const usageResp = await fetch(
          `https://admin-api.helius.xyz/v0/admin/projects/${encodeURIComponent(projectId)}/usage`,
          {
            headers: { "X-Api-Key": key },
            signal: AbortSignal.timeout(12_000),
          },
        );
        const raw = await usageResp.json() as Record<string, unknown>;
        if (!usageResp.ok) {
          usageError = typeof raw?.error === "string"
            ? raw.error
            : typeof raw?.message === "string"
              ? raw.message
              : `Admin API HTTP ${usageResp.status}`;
        } else {
          const sub = (raw.subscriptionDetails ?? {}) as Record<string, unknown>;
          const cycle = (raw.creditCycle ?? sub.billingCycle ?? {}) as Record<string, unknown>;
          usage = {
            creditsRemaining: raw.creditsRemaining != null ? Number(raw.creditsRemaining) : null,
            creditsUsed: raw.creditsUsed != null ? Number(raw.creditsUsed) : null,
            creditsLimit: sub.creditsLimit != null ? Number(sub.creditsLimit) : null,
            plan: sub.plan != null ? String(sub.plan) : null,
            cycleStart: cycle.start != null ? String(cycle.start) : null,
            cycleEnd: cycle.end != null ? String(cycle.end) : null,
            prepaidCreditsRemaining: raw.prepaidCreditsRemaining != null
              ? Number(raw.prepaidCreditsRemaining) : null,
          };
        }
      } catch (err) {
        usageError = err instanceof Error ? err.message : String(err);
      }
    } else {
      usageError = "Save Helius Project ID to fetch credit limit (dashboard → top-left)";
    }

    res.json(apiOk({
      keyConfigured: true,
      rpcOk,
      rpcError,
      rpcLatencyMs,
      slot,
      projectId: projectId ?? null,
      usage,
      usageError,
      checkedAt: new Date().toISOString(),
    }));
  } catch (err) {
    req.log.error({ err }, "Helius usage check failed");
    res.status(500).json(apiFail("Internal server error", "helius_usage"));
  }
});

export default router;
