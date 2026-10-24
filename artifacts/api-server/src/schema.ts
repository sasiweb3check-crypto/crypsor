export const schemaSql = `
CREATE SCHEMA IF NOT EXISTS hunter;
CREATE TABLE IF NOT EXISTS hunter.runtime_setting (
 name text PRIMARY KEY, ciphertext text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE IF EXISTS hunter.token ADD COLUMN IF NOT EXISTS image_uri text;
ALTER TABLE IF EXISTS hunter.token ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE IF EXISTS hunter.token ADD COLUMN IF NOT EXISTS market_data jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS hunter.operator_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 mode text NOT NULL DEFAULT 'WATCH_ONLY' CHECK(mode IN('FULL','WATCH_ONLY','PAUSE_RESEARCH','STOP_ALL')),
 updated_at timestamptz NOT NULL DEFAULT now(), reason text NOT NULL DEFAULT 'Initial safe pilot mode'
);
INSERT INTO hunter.operator_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS hunter.operator_audit (
 id bigserial PRIMARY KEY, action text NOT NULL, reason text NOT NULL DEFAULT '', data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hunter.watched_wallet (
 address text PRIMARY KEY, label text NOT NULL DEFAULT '', active boolean NOT NULL DEFAULT true,
 cursor text, pending_cursor text, backfill_head text, reconcile_lease_until timestamptz, reconcile_lease_token text, last_success_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE hunter.watched_wallet ADD COLUMN IF NOT EXISTS reconcile_lease_until timestamptz;
ALTER TABLE hunter.watched_wallet ADD COLUMN IF NOT EXISTS reconcile_lease_token text;
CREATE TABLE IF NOT EXISTS hunter.token (
 mint text PRIMARY KEY, name text, symbol text, discovered_at timestamptz NOT NULL DEFAULT now(),
 price_usd numeric, liquidity_usd numeric, market_updated_at timestamptz,
 priority text NOT NULL DEFAULT 'UNKNOWN', risk text NOT NULL DEFAULT 'UNKNOWN', confidence text NOT NULL DEFAULT 'LOW'
);
ALTER TABLE hunter.token ADD COLUMN IF NOT EXISTS image_uri text;
ALTER TABLE hunter.token ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE hunter.token ADD COLUMN IF NOT EXISTS market_data jsonb NOT NULL DEFAULT '{}';
ALTER TABLE hunter.token ADD COLUMN IF NOT EXISTS enrichment_state text NOT NULL DEFAULT 'pending';
ALTER TABLE hunter.token ADD COLUMN IF NOT EXISTS enrichment_checked_at timestamptz;
ALTER TABLE hunter.token ADD COLUMN IF NOT EXISTS coverage jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS hunter.onchain_event (
 id bigserial PRIMARY KEY, signature text NOT NULL, instruction_path text NOT NULL, event_kind text NOT NULL,
 wallet_address text REFERENCES hunter.watched_wallet(address), mint text REFERENCES hunter.token(mint),
 slot bigint, block_time timestamptz, observed_at timestamptz NOT NULL DEFAULT now(), commitment text NOT NULL DEFAULT 'provider_reported',
 observations jsonb NOT NULL DEFAULT '{}', UNIQUE(signature,instruction_path,event_kind)
);
CREATE INDEX IF NOT EXISTS event_mint_time ON hunter.onchain_event(mint,observed_at DESC);
CREATE INDEX IF NOT EXISTS event_wallet_time ON hunter.onchain_event(wallet_address,observed_at DESC);
CREATE TABLE IF NOT EXISTS hunter.source_document (
 id bigserial PRIMARY KEY, mint text REFERENCES hunter.token(mint), provider text NOT NULL, url text,
 fetched_at timestamptz NOT NULL DEFAULT now(), source_timestamp timestamptz, payload jsonb,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days'
);
CREATE INDEX IF NOT EXISTS source_mint ON hunter.source_document(mint,fetched_at DESC);
CREATE TABLE IF NOT EXISTS hunter.token_metadata_version (
 id bigserial PRIMARY KEY, mint text NOT NULL REFERENCES hunter.token(mint), source_document_id bigint REFERENCES hunter.source_document(id),
 observed_at timestamptz NOT NULL DEFAULT now(), name text, symbol text, metadata_uri text, image_uri text,
 decimals int, supply text, mint_authority text, freeze_authority text, data jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS hunter.holder_snapshot (
 id bigserial PRIMARY KEY, mint text NOT NULL REFERENCES hunter.token(mint), source_document_id bigint REFERENCES hunter.source_document(id),
 captured_at timestamptz NOT NULL DEFAULT now(), holders jsonb NOT NULL DEFAULT '[]', features jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS hunter.relation_edge (
 id bigserial PRIMARY KEY, source text NOT NULL, target text NOT NULL, kind text NOT NULL, mint text REFERENCES hunter.token(mint),
 evidence_ids jsonb NOT NULL DEFAULT '[]', first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 data jsonb NOT NULL DEFAULT '{}', UNIQUE(source,target,kind,mint)
);
CREATE TABLE IF NOT EXISTS hunter.evidence_claim (
 id bigserial PRIMARY KEY, mint text REFERENCES hunter.token(mint), source_document_id bigint REFERENCES hunter.source_document(id),
 claim text NOT NULL, status text NOT NULL DEFAULT 'OBSERVED', confidence text NOT NULL DEFAULT 'LOW',
 known_at timestamptz NOT NULL DEFAULT now(), data jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS evidence_mint ON hunter.evidence_claim(mint,known_at DESC);
CREATE TABLE IF NOT EXISTS hunter.investigation_job (
 id bigserial PRIMARY KEY, kind text NOT NULL, mint text REFERENCES hunter.token(mint), payload jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','done','dead')),
 attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 5, run_after timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, lease_token text, last_error text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 dedupe_key text UNIQUE
);
WITH recovered AS (
 UPDATE hunter.investigation_job SET status='queued',attempts=0,run_after=now()+interval '1 hour',finished_at=NULL
 WHERE status='dead' AND last_error IN('REQUEST_CAP_EXHAUSTED','PROVIDER_RATE_LIMIT','PROVIDER_HTTP_429') RETURNING id
) INSERT INTO hunter.operator_audit(action,reason,data)
 SELECT 'quota.recovery','Recover legacy quota-dead jobs under deferred quota retry policy',jsonb_build_object('count',count(*)) FROM recovered HAVING count(*)>0;
CREATE INDEX IF NOT EXISTS job_due ON hunter.investigation_job(status,run_after);
CREATE TABLE IF NOT EXISTS hunter.decision_version (
 id bigserial PRIMARY KEY, mint text NOT NULL REFERENCES hunter.token(mint), version int NOT NULL, action text NOT NULL,
 thesis text NOT NULL, counter_thesis text NOT NULL, unknowns jsonb NOT NULL DEFAULT '[]', evidence_ids jsonb NOT NULL DEFAULT '[]',
 contradictions jsonb NOT NULL DEFAULT '[]', gate jsonb NOT NULL DEFAULT '{}', reviewer_result text,
 model_version text, rule_version text, known_at timestamptz NOT NULL DEFAULT now(), next_recheck_at timestamptz,
 spend_usd numeric NOT NULL DEFAULT 0, context jsonb NOT NULL DEFAULT '{}', UNIQUE(mint,version)
);
CREATE INDEX IF NOT EXISTS decision_mint_time ON hunter.decision_version(mint,known_at DESC);
CREATE TABLE IF NOT EXISTS hunter.prediction (
 id bigserial PRIMARY KEY, mint text REFERENCES hunter.token(mint), decision_id bigint REFERENCES hunter.decision_version(id),
 window_minutes int, hypothesis text NOT NULL, target jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'OPEN',
 created_at timestamptz NOT NULL DEFAULT now(), due_at timestamptz
);
CREATE TABLE IF NOT EXISTS hunter.outcome (
 id bigserial PRIMARY KEY, prediction_id bigint REFERENCES hunter.prediction(id), evaluated_at timestamptz NOT NULL DEFAULT now(),
 result text NOT NULL, evidence_ids jsonb NOT NULL DEFAULT '[]', details jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS hunter.alert (
 id text PRIMARY KEY, mint text REFERENCES hunter.token(mint), event_id bigint REFERENCES hunter.onchain_event(id),
 kind text NOT NULL DEFAULT 'DISCOVERY', status text NOT NULL DEFAULT 'pending', payload jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, last_error text, telegram_message_id text
);
CREATE TABLE IF NOT EXISTS hunter.vendor_usage (
 id bigserial PRIMARY KEY, provider text NOT NULL, operation text NOT NULL, requests int NOT NULL DEFAULT 1,
 estimated_cost_usd numeric NOT NULL DEFAULT 0 CHECK(estimated_cost_usd>=0), mint text, recorded_at timestamptz NOT NULL DEFAULT now(), outcome text NOT NULL DEFAULT 'reserved'
);
CREATE INDEX IF NOT EXISTS usage_provider_time ON hunter.vendor_usage(provider,recorded_at DESC);
CREATE TABLE IF NOT EXISTS hunter.worker_heartbeat (
 id text PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT now(), last_error text
);
CREATE OR REPLACE FUNCTION hunter.deny_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'Hunter historical records are append-only'; END $$;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['decision_version','evidence_claim','operator_audit','outcome'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='append_only_'||name AND tgrelid=('hunter.'||name)::regclass) THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON hunter.%I FOR EACH ROW EXECUTE FUNCTION hunter.deny_history_mutation()', 'append_only_'||name,name);
  END IF;
 END LOOP;
END $$;
`;
