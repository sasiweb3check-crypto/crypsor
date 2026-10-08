import type { Pool } from "pg";
export async function migrate(pool: Pool) {
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock(731925)");
    await c.query(
      `CREATE TABLE IF NOT EXISTS cw_schema(version int PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    if ((await c.query("SELECT 1 FROM cw_schema WHERE version=2")).rowCount)
      return;
    await c.query("BEGIN");
    await c.query(`
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   CREATE TABLE IF NOT EXISTS cw_wallets(address text PRIMARY KEY,label text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),cursor text,synced_at timestamptz,sync_error text);
   CREATE TABLE IF NOT EXISTS cw_tokens(mint text PRIMARY KEY,symbol text,name text,image text,entry_price double precision,entry_source text,entry_at timestamptz NOT NULL,detected_at timestamptz NOT NULL DEFAULT now(),current_price double precision,peak_price double precision,priced_at timestamptz);
   CREATE TABLE IF NOT EXISTS cw_buys(wallet text NOT NULL,mint text NOT NULL REFERENCES cw_tokens(mint),signature text NOT NULL,bought_at timestamptz NOT NULL,purchase_price double precision,PRIMARY KEY(wallet,mint,signature));
   CREATE TABLE IF NOT EXISTS cw_prices(id bigserial PRIMARY KEY,mint text NOT NULL REFERENCES cw_tokens(mint),price double precision NOT NULL,at timestamptz NOT NULL DEFAULT now());
   ALTER TABLE cw_wallets ADD COLUMN IF NOT EXISTS next_sync_at timestamptz NOT NULL DEFAULT now();
   ALTER TABLE cw_wallets ADD COLUMN IF NOT EXISTS catchup_before text;
   ALTER TABLE cw_wallets ADD COLUMN IF NOT EXISTS catchup_head text;
   ALTER TABLE cw_wallets ADD COLUMN IF NOT EXISTS catchup_target text;
   ALTER TABLE cw_tokens ADD COLUMN IF NOT EXISTS price_checked_at timestamptz;
   ALTER TABLE cw_tokens ADD COLUMN IF NOT EXISTS price_due_at timestamptz NOT NULL DEFAULT now();
   ALTER TABLE cw_tokens ADD COLUMN IF NOT EXISTS metadata_due_at timestamptz NOT NULL DEFAULT now();
   ALTER TABLE cw_tokens ADD COLUMN IF NOT EXISTS metadata_at timestamptz;
   ALTER TABLE cw_tokens ADD COLUMN IF NOT EXISTS metadata_source text;
   ALTER TABLE cw_tokens ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';
   ALTER TABLE cw_tokens ADD COLUMN IF NOT EXISTS last_viewed_at timestamptz;
   ALTER TABLE cw_tokens ADD COLUMN IF NOT EXISTS last_buy_at timestamptz;
   ALTER TABLE cw_tokens ADD COLUMN IF NOT EXISTS buy_count bigint NOT NULL DEFAULT 0;
   ALTER TABLE cw_tokens ADD COLUMN IF NOT EXISTS wallet_count int NOT NULL DEFAULT 0;
   ALTER TABLE cw_tokens ADD COLUMN IF NOT EXISTS history jsonb NOT NULL DEFAULT '[]';
   ALTER TABLE cw_tokens ADD COLUMN IF NOT EXISTS gain double precision GENERATED ALWAYS AS(CASE WHEN entry_price>0 AND current_price IS NOT NULL THEN(current_price/entry_price-1)*100 END) STORED;
   ALTER TABLE cw_tokens ADD COLUMN IF NOT EXISTS peak_gain double precision GENERATED ALWAYS AS(CASE WHEN entry_price>0 AND peak_price IS NOT NULL THEN(peak_price/entry_price-1)*100 END) STORED;
   ALTER TABLE cw_tokens ADD COLUMN IF NOT EXISTS search_text text GENERATED ALWAYS AS(lower(mint||' '||COALESCE(symbol,'')||' '||COALESCE(name,''))) STORED;
   ALTER TABLE cw_buys ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'helius-enhanced';
   ALTER TABLE cw_buys ADD COLUMN IF NOT EXISTS parser_version text NOT NULL DEFAULT 'buys-v1';
   CREATE TABLE IF NOT EXISTS cw_token_wallets(mint text NOT NULL REFERENCES cw_tokens(mint),wallet text NOT NULL,buys bigint NOT NULL DEFAULT 0,first_buy_at timestamptz NOT NULL,last_buy_at timestamptz NOT NULL,PRIMARY KEY(mint,wallet));
   CREATE TABLE IF NOT EXISTS cw_wallet_stats(address text PRIMARY KEY,buys bigint NOT NULL DEFAULT 0,tokens bigint NOT NULL DEFAULT 0,priced bigint NOT NULL DEFAULT 0,positive bigint NOT NULL DEFAULT 0,gain_sum double precision NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS cw_stats(bucket int PRIMARY KEY,tokens bigint NOT NULL DEFAULT 0,priced bigint NOT NULL DEFAULT 0,positive bigint NOT NULL DEFAULT 0,gain_sum double precision NOT NULL DEFAULT 0);
   INSERT INTO cw_stats(bucket) SELECT generate_series(0,63) ON CONFLICT DO NOTHING;
   CREATE TABLE IF NOT EXISTS cw_jobs(id bigserial PRIMARY KEY,kind text NOT NULL,job_key text NOT NULL,payload jsonb NOT NULL DEFAULT '{}',state text NOT NULL DEFAULT 'queued',priority int NOT NULL DEFAULT 0,attempts int NOT NULL DEFAULT 0,max_attempts int NOT NULL DEFAULT 8,available_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,lease_token text,published_at timestamptz,error text,finished_at timestamptz);
   CREATE UNIQUE INDEX IF NOT EXISTS cw_jobs_unique ON cw_jobs(job_key) WHERE state IN('queued','running');
   CREATE INDEX IF NOT EXISTS cw_jobs_claim ON cw_jobs(kind,available_at,priority DESC,id) WHERE state='queued';
   CREATE INDEX IF NOT EXISTS cw_jobs_health ON cw_jobs(state,created_at) WHERE state IN('queued','running','dead');
   CREATE INDEX IF NOT EXISTS cw_jobs_finished ON cw_jobs(finished_at) WHERE state IN('done','dead');
   CREATE INDEX IF NOT EXISTS cw_jobs_errors ON cw_jobs(id DESC) WHERE error IS NOT NULL AND state IN('queued','dead');
   CREATE INDEX IF NOT EXISTS cw_jobs_dead_key ON cw_jobs(job_key,finished_at) WHERE state='dead';
   CREATE INDEX IF NOT EXISTS cw_jobs_lease ON cw_jobs(lease_until) WHERE state='running';
   CREATE TABLE IF NOT EXISTS cw_workers(id text PRIMARY KEY,seen_at timestamptz NOT NULL DEFAULT now(),details jsonb NOT NULL DEFAULT '{}');
   CREATE TABLE IF NOT EXISTS cw_rate_limits(provider text PRIMARY KEY,next_at timestamptz NOT NULL);
   CREATE TABLE IF NOT EXISTS cw_receipts(signature text PRIMARY KEY,payload jsonb NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),archived boolean NOT NULL DEFAULT false);
   CREATE INDEX IF NOT EXISTS cw_receipts_unarchived ON cw_receipts(received_at) WHERE archived=false;
   CREATE INDEX IF NOT EXISTS cw_receipts_retention ON cw_receipts(received_at);
   CREATE TABLE IF NOT EXISTS cw_insights(mint text PRIMARY KEY REFERENCES cw_tokens(mint),version text NOT NULL,computed_at timestamptz NOT NULL DEFAULT now(),facts jsonb NOT NULL);
   CREATE INDEX IF NOT EXISTS cw_tokens_recent ON cw_tokens(detected_at DESC,mint DESC);
   CREATE INDEX IF NOT EXISTS cw_tokens_gain ON cw_tokens(gain DESC NULLS LAST,mint DESC) WHERE gain IS NOT NULL;
   CREATE INDEX IF NOT EXISTS cw_tokens_peak ON cw_tokens(peak_gain DESC NULLS LAST,mint DESC) WHERE peak_gain IS NOT NULL;
   CREATE INDEX IF NOT EXISTS cw_tokens_search ON cw_tokens USING gin(search_text gin_trgm_ops);
   CREATE INDEX IF NOT EXISTS cw_tokens_price_due ON cw_tokens(price_due_at,mint);
   CREATE INDEX IF NOT EXISTS cw_tokens_meta_due ON cw_tokens(metadata_due_at,mint);
   CREATE INDEX IF NOT EXISTS cw_wallet_due ON cw_wallets(next_sync_at);
   CREATE INDEX IF NOT EXISTS cw_buys_mint_time ON cw_buys(mint,bought_at DESC);
   CREATE INDEX IF NOT EXISTS cw_token_wallets_wallet ON cw_token_wallets(wallet,mint);
   CREATE INDEX IF NOT EXISTS cw_prices_mint ON cw_prices(mint,id DESC);
   INSERT INTO cw_token_wallets(mint,wallet,buys,first_buy_at,last_buy_at) SELECT mint,wallet,count(*),min(bought_at),max(bought_at) FROM cw_buys GROUP BY mint,wallet ON CONFLICT DO NOTHING;
   UPDATE cw_tokens t SET buy_count=s.buys,wallet_count=s.wallets,last_buy_at=s.last_at FROM(SELECT mint,count(*) AS buys,count(DISTINCT wallet) AS wallets,max(bought_at) AS last_at FROM cw_buys GROUP BY mint)s WHERE t.mint=s.mint;
   UPDATE cw_tokens t SET history=COALESCE((SELECT jsonb_agg(jsonb_build_object('price',p.price,'at',p.at) ORDER BY p.id) FROM(SELECT price,at,id FROM cw_prices WHERE mint=t.mint ORDER BY id DESC LIMIT 30)p),'[]');
   INSERT INTO cw_wallet_stats(address,buys,tokens,priced,positive,gain_sum) SELECT tw.wallet,sum(tw.buys),count(*),count(t.gain),count(*) FILTER(WHERE t.gain>0),COALESCE(sum(t.gain),0) FROM cw_token_wallets tw JOIN cw_tokens t ON t.mint=tw.mint GROUP BY tw.wallet ON CONFLICT(address) DO UPDATE SET buys=EXCLUDED.buys,tokens=EXCLUDED.tokens,priced=EXCLUDED.priced,positive=EXCLUDED.positive,gain_sum=EXCLUDED.gain_sum;
   UPDATE cw_stats SET tokens=0,priced=0,positive=0,gain_sum=0;
   INSERT INTO cw_stats(bucket,tokens,priced,positive,gain_sum) SELECT(hashtext(mint)::bigint & 63)::int,count(*),count(gain),count(*) FILTER(WHERE gain>0),COALESCE(sum(gain),0) FROM cw_tokens GROUP BY 1 ON CONFLICT(bucket) DO UPDATE SET tokens=EXCLUDED.tokens,priced=EXCLUDED.priced,positive=EXCLUDED.positive,gain_sum=EXCLUDED.gain_sum;
   CREATE OR REPLACE FUNCTION cw_token_stats_change() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE old_gain double precision;new_gain double precision;delta_tokens int:=0;bucket_id int;
   BEGIN
    IF TG_OP='DELETE' THEN old_gain:=OLD.gain;delta_tokens:=-1;bucket_id:=(hashtext(OLD.mint)::bigint & 63)::int;
    ELSE new_gain:=NEW.gain;bucket_id:=(hashtext(NEW.mint)::bigint & 63)::int;IF TG_OP='INSERT' THEN delta_tokens:=1;ELSE old_gain:=OLD.gain;END IF;END IF;
    IF delta_tokens<>0 OR old_gain IS DISTINCT FROM new_gain THEN
     UPDATE cw_stats SET tokens=tokens+delta_tokens,priced=priced+(new_gain IS NOT NULL)::int-(old_gain IS NOT NULL)::int,positive=positive+COALESCE((new_gain>0)::int,0)-COALESCE((old_gain>0)::int,0),gain_sum=gain_sum+COALESCE(new_gain,0)-COALESCE(old_gain,0) WHERE bucket=bucket_id;
     UPDATE cw_wallet_stats ws SET priced=ws.priced+(new_gain IS NOT NULL)::int-(old_gain IS NOT NULL)::int,positive=ws.positive+COALESCE((new_gain>0)::int,0)-COALESCE((old_gain>0)::int,0),gain_sum=ws.gain_sum+COALESCE(new_gain,0)-COALESCE(old_gain,0) FROM cw_token_wallets tw WHERE tw.wallet=ws.address AND tw.mint=COALESCE(NEW.mint,OLD.mint);
    END IF;
    RETURN NULL;
   END $$;
   DROP TRIGGER IF EXISTS cw_token_stats ON cw_tokens;
   CREATE TRIGGER cw_token_stats AFTER INSERT OR UPDATE OR DELETE ON cw_tokens FOR EACH ROW EXECUTE FUNCTION cw_token_stats_change();
   INSERT INTO cw_schema(version) VALUES(2);
  `);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    await c.query("SELECT pg_advisory_unlock(731925)");
    c.release();
  }
}
