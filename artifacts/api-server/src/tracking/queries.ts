import { pool } from "./store.ts";
export type PageOptions = {
  cursor?: string;
  query?: string;
  sort?: string;
  limit?: number;
  wallet?: string;
};
export function parseCursor(
  cursor: string | undefined,
  sort: string,
  query: string,
  wallet: string,
) {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      v.sort !== sort ||
      v.query !== query ||
      v.wallet !== wallet ||
      typeof v.mint !== "string" ||
      (typeof v.value !== "string" && typeof v.value !== "number")
    )
      throw new Error();
    if (sort === "recent" && !Number.isFinite(Date.parse(v.value)))
      throw new Error();
    if (sort !== "recent" && !Number.isFinite(Number(v.value)))
      throw new Error();
    return v;
  } catch {
    throw new Error("Invalid page cursor");
  }
}
export async function tokenPage(options: PageOptions = {}) {
  const limit = Number.isFinite(options.limit)
      ? Math.max(1, Math.min(50, Math.floor(options.limit!)))
      : 25,
    query = (options.query ?? "").trim().slice(0, 100),
    wallet = (options.wallet ?? "").slice(0, 44);
  const sort = ["gain", "peak"].includes(options.sort ?? "")
    ? options.sort!
    : "recent";
  const column =
    sort === "recent" ? "detected_at" : sort === "gain" ? "gain" : "peak_gain";
  const cursor = parseCursor(options.cursor, sort, query, wallet);
  const params: any[] = [];
  const terms: string[] = [];
  function bind(value: any) {
    params.push(value);
    return `$${params.length}`;
  }
  if (sort !== "recent") terms.push(`${column}>0`);
  if (query)
    terms.push(
      `search_text LIKE ${bind("%" + query.toLowerCase().replace(/[\\%_]/g, "\\$&") + "%")} ESCAPE '\\'`,
    );
  if (wallet)
    terms.push(
      `EXISTS(SELECT 1 FROM cw_token_wallets tw WHERE tw.mint=cw_tokens.mint AND tw.wallet=${bind(wallet)})`,
    );
  if (cursor)
    terms.push(
      `(${column},mint)<(${bind(cursor.value)}::${sort === "recent" ? "timestamptz" : "double precision"},${bind(cursor.mint)})`,
    );
  const p = bind(limit + 1);
  const rows = (
    await pool.query(
      `SELECT mint,symbol,name,image,entry_price,entry_source,entry_at,detected_at,current_price,peak_price,gain,peak_gain,priced_at,price_due_at,metadata_at,buy_count,wallet_count,history FROM cw_tokens ${terms.length ? "WHERE " + terms.join(" AND ") : ""} ORDER BY ${column} DESC${sort === "recent" ? "" : " NULLS LAST"},mint DESC LIMIT ${p}`,
      params,
    )
  ).rows;
  const more = rows.length > limit;
  const selected = rows.slice(0, limit),
    mints = selected.map((t) => t.mint);
  const links = mints.length
    ? (
        await pool.query(
          `SELECT m.mint,l.address,l.label FROM unnest($1::text[])m(mint) CROSS JOIN LATERAL(SELECT tw.wallet AS address,COALESCE(w.label,'') AS label FROM cw_token_wallets tw LEFT JOIN cw_wallets w ON w.address=tw.wallet WHERE tw.mint=m.mint ORDER BY tw.first_buy_at LIMIT 5)l`,
          [mints],
        )
      ).rows
    : [];
  // Only visible assets receive a demand-based refresh, and writes are capped to once a minute.
  if (mints.length)
    await pool.query(
      "UPDATE cw_tokens SET last_viewed_at=now(),price_due_at=LEAST(price_due_at,now()+interval '30 seconds') WHERE mint=ANY($1) AND(last_viewed_at IS NULL OR last_viewed_at<now()-interval '1 minute')",
      [mints],
    );
  const tokens = selected.map((t) => ({
    ...t,
    buys: Number(t.buy_count),
    wallets: links.filter((w) => w.mint === t.mint).slice(0, 5),
    history: t.history.map((h: any) => h.price),
    priceStale:
      !t.priced_at ||
      Date.now() - new Date(t.priced_at).getTime() >
        Math.max(
          120_000,
          new Date(t.price_due_at).getTime() -
            new Date(t.priced_at).getTime() +
            60_000,
        ),
  }));
  const last = selected.at(-1);
  const nextCursor =
    more && last
      ? Buffer.from(
          JSON.stringify({
            sort,
            query,
            wallet,
            mint: last.mint,
            value: last[column],
          }),
        ).toString("base64url")
      : null;
  return { tokens, page: { nextCursor, hasMore: more, limit, sort } };
}
let summaryCache: { at: number; data: any } | null = null;
export function invalidateSummary() {
  summaryCache = null;
}
export async function summary() {
  if (summaryCache && Date.now() - summaryCache.at < 5000)
    return summaryCache.data;
  const [stats, wallets, leaders] = await Promise.all([
    pool.query(
      "SELECT sum(tokens)::text AS tokens,sum(priced)::text AS priced,sum(positive)::text AS positive,COALESCE(sum(gain_sum),0) AS gain_sum FROM cw_stats",
    ),
    pool.query(
      `SELECT w.address,w.label,w.created_at,w.synced_at,w.sync_error,w.scanned_transactions,w.scanned_swaps,w.last_scan_at,w.catchup_before IS NOT NULL AS catching_up,COALESCE(s.buys,0)::text AS buys,COALESCE(s.tokens,0)::text AS tokens,COALESCE(s.priced,0)::text AS priced,CASE WHEN s.priced>0 THEN s.gain_sum/s.priced END AS avg_gain,CASE WHEN s.priced>0 THEN s.positive*100.0/s.priced END AS positive_rate FROM cw_wallets w LEFT JOIN cw_wallet_stats s ON s.address=w.address ORDER BY w.created_at DESC`,
    ),
    pool.query(
      "SELECT mint,symbol,name,gain,peak_gain FROM cw_tokens WHERE gain>0 ORDER BY gain DESC NULLS LAST,mint DESC LIMIT 3",
    ),
  ]);
  const s = stats.rows[0],
    data = {
      wallets: wallets.rows.map((w) => ({
        ...w,
        buys: Number(w.buys),
        tokens: Number(w.tokens),
        scanned_transactions: Number(w.scanned_transactions),
        scanned_swaps: Number(w.scanned_swaps),
      })),
      summary: {
        wallets: wallets.rowCount,
        tokens: Number(s.tokens ?? 0),
        priced: Number(s.priced ?? 0),
        positive: Number(s.positive ?? 0),
        averageGain:
          Number(s.priced) > 0 ? Number(s.gain_sum) / Number(s.priced) : null,
      },
      leaders: leaders.rows,
    };
  summaryCache = { at: Date.now(), data };
  return data;
}
export async function tokenDetail(mint: string) {
  const t = (await pool.query("SELECT * FROM cw_tokens WHERE mint=$1", [mint]))
    .rows[0];
  if (!t) return null;
  const [insight, buys] = await Promise.all([
    pool.query(
      "SELECT version,computed_at,facts FROM cw_insights WHERE mint=$1",
      [mint],
    ),
    pool.query(
      "SELECT wallet,signature,bought_at,purchase_price,source,parser_version FROM cw_buys WHERE mint=$1 ORDER BY bought_at DESC LIMIT 20",
      [mint],
    ),
  ]);
  return { ...t, insight: insight.rows[0] ?? null, recentBuys: buys.rows };
}
