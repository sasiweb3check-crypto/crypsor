import { pool } from "../core/db";
import { emitSse } from "../core/bus";
import { logger } from "../core/log";

const log = logger.child({ module: "agent" });

export async function agentNote(
  agent: string,
  action: string,
  detail: string,
  opts: { tokenId?: number; mint?: string; quiet?: boolean } = {},
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO ward_agent_log (agent, action, token_id, mint, detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [agent, action, opts.tokenId ?? null, opts.mint ?? null, detail.slice(0, 800)],
    );
    if (!opts.quiet) {
      emitSse("agent:note", { agent, action, detail, mint: opts.mint, at: new Date().toISOString() });
    }
  } catch (err) {
    log.debug({ err }, "agent log insert failed");
  }
}
