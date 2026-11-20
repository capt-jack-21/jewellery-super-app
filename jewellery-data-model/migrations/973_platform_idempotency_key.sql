-- 973_platform_idempotency_key.sql — generic API idempotency store (Idempotency-Key header) for non-invoice routes.
-- Modelled on sales.idempotency_key (100 + 900/960 policies). Flow (app): INSERT the key + request hash + stored response
-- in the same transaction as the side effect; a retry or a concurrent duplicate hits the unique key (23505) and the app
-- returns the stored response (or 422 if request_hash differs). No pending state, never UPDATEd. app_rw may DELETE only
-- expired rows of its own tenant (expires_at <= now()), so an expired key can be deleted and re-used in one transaction.
-- TTL 24 h via expires_at; a pg-boss job (app_worker) deletes expired rows, like the sales 24 h retention job.
-- No DB functions. The 960 RLS/grant loops ran before this table existed, so its policies/grants are set here explicitly.

CREATE TABLE platform.idempotency_key (
  tenant_id       uuid        NOT NULL REFERENCES platform.tenant(id),
  scope           text        NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 200
                                              AND scope ~ '^(POST|PUT|PATCH|DELETE) /v1/[^[:space:]]*$'),  -- method + /v1 route template
  key             text        NOT NULL CHECK (char_length(key) BETWEEN 1 AND 255),
  request_hash    text        NOT NULL CHECK (char_length(request_hash) BETWEEN 1 AND 128),          -- e.g. sha256 hex of the body
  response_status smallint    NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  response_body   jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  CONSTRAINT idempotency_key_expiry_after_create CHECK (expires_at > created_at),
  CONSTRAINT idempotency_key_pkey PRIMARY KEY (tenant_id, scope, key)
);
CREATE INDEX idempotency_key_expires_idx ON platform.idempotency_key (expires_at);
COMMENT ON TABLE platform.idempotency_key IS 'API Idempotency-Key replay store; insert-only for app_rw; app_worker purges expires_at < now()';

-- ---------- RLS (same policies the 960 loops give every platform tenant table) ----------
ALTER TABLE platform.idempotency_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.idempotency_key FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform.idempotency_key
  USING (tenant_id = platform.current_tenant()) WITH CHECK (tenant_id = platform.current_tenant());
CREATE POLICY no_partner_access ON platform.idempotency_key AS RESTRICTIVE
  USING (platform.current_partner() IS NULL) WITH CHECK (platform.current_partner() IS NULL);
-- purge: the worker (no app.tenant_id) sees and deletes only expired rows, across tenants
CREATE POLICY worker_purge_read ON platform.idempotency_key FOR SELECT TO app_worker USING (expires_at < now());
CREATE POLICY worker_purge      ON platform.idempotency_key FOR DELETE TO app_worker USING (expires_at < now());
-- app_rw: DELETE narrowed to expired rows; restrictive, so it ANDs with tenant_isolation (own tenant + expired)
CREATE POLICY rw_delete_expired_only ON platform.idempotency_key AS RESTRICTIVE FOR DELETE TO app_rw USING (expires_at <= now());

-- ---------- grants ----------
REVOKE ALL ON platform.idempotency_key FROM PUBLIC, app_ro, app_rw, app_worker;   -- drops the default-privilege SELECT for app_ro
GRANT SELECT, INSERT, DELETE ON platform.idempotency_key TO app_rw;               -- no UPDATE; DELETE = own expired rows (RLS)
GRANT SELECT, DELETE ON platform.idempotency_key TO app_worker;                   -- purge only (RLS: expired rows)
-- app_ro: none (stored responses may carry customer data; operational table like rate_limit_bucket)
-- Roles that can still DELETE here outside these grants (owner/admin chain, by design): app_migrator (table owner),
-- superusers (bypass RLS), and the predefined pg_write_all_data (no members). See README 973.
