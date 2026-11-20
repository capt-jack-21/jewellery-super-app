-- 910_platform_v14_v18.sql — platform changes from v1.4–v1.8 that came after the applied 010/025 (dev, 2026-10-24).
-- Applied migrations (000–900) are IMMUTABLE: every later change goes in a new file that sorts after 900_security.sql.

-- ---------- optimistic concurrency: generic bump_version (column name in TG_ARGV[0], INSERT resets to 1) ----------
-- branding.print_template uses `row_version` because its `version` column is the template's document version
-- (part of print_template_version_uq) and must never be bumped.
CREATE OR REPLACE FUNCTION platform.bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE col text := coalesce(TG_ARGV[0], 'version');
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW := jsonb_populate_record(NEW, jsonb_build_object(col, 1));
    RETURN NEW;
  END IF;
  IF to_jsonb(NEW) -> col IS DISTINCT FROM to_jsonb(OLD) -> col THEN
    RAISE EXCEPTION '% is maintained by the database (optimistic concurrency)', col;
  END IF;
  NEW := jsonb_populate_record(NEW, jsonb_build_object(col, (to_jsonb(OLD) ->> col)::int + 1));
  RETURN NEW;
END $$;

-- re-create the aa_version triggers as BEFORE INSERT OR UPDATE; print_template moves to row_version
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform.partner','platform.tenant','platform.company','platform.branch','platform.app_user',
                           'platform.role','platform.setting','platform.device','platform.import_mapping_profile',
                           'platform.partner_user','branding.theme','branding.custom_domain','branding.print_template',
                           'branding.sender_config'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS aa_version ON %s', t);
    IF t = 'branding.print_template' THEN
      EXECUTE format('ALTER TABLE %s ADD COLUMN row_version int NOT NULL DEFAULT 1', t);
      EXECUTE format('CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION platform.bump_version(%L)', t, 'row_version');
    ELSE
      EXECUTE format('CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION platform.bump_version()', t);
    END IF;
  END LOOP;
END $$;

-- ---------- removed columns ----------
ALTER TABLE platform.company  DROP COLUMN bank_accounts;                     -- now masters.bank_account (930)
ALTER TABLE platform.app_user DROP COLUMN failed_logins, DROP COLUMN locked_until;   -- now platform.rate_limit_bucket

-- ---------- import job -> saved mapping profile (same tenant + kind) ----------
ALTER TABLE platform.import_job ADD COLUMN mapping_profile_id uuid;
ALTER TABLE platform.import_mapping_profile ADD CONSTRAINT import_mapping_profile_tenant_id_id_kind_key
  UNIQUE (tenant_id, id, kind);                                             -- FK target: a job may only use a profile of its own kind
ALTER TABLE platform.import_job ADD CONSTRAINT import_job_mapping_profile_fk
  FOREIGN KEY (tenant_id, mapping_profile_id, kind) REFERENCES platform.import_mapping_profile(tenant_id, id, kind);

-- ---------- generic rate limiting / lockout (tenant, partner, admin logins and OTP) ----------
-- Keys are built by the app and never contain raw PII: '<surface>:<scope uuid|->:<sha256 hex of identifier|uuid>'.
-- No tenant RLS: consulted BEFORE authentication; rows carry only counters. Grants in 960.
CREATE TABLE platform.rate_limit_bucket (
  bucket_key   text NOT NULL CHECK (bucket_key ~ '^(login\.(tenant|partner|admin)|otp\.(send|verify)):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|-):([0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  window_start timestamptz NOT NULL,
  count        int NOT NULL DEFAULT 0 CHECK (count >= 0),
  locked_until timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_key, window_start)
);
CREATE INDEX rate_limit_bucket_window_idx ON platform.rate_limit_bucket (window_start);
