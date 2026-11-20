-- 010_platform.sql — tenancy, branches, users, roles/permissions, licence, settings, audit log (INV-3)
SET search_path = platform, public;

-- ---------- helpers ----------
CREATE FUNCTION platform.uuid_v7() RETURNS uuid LANGUAGE plpgsql VOLATILE AS $$
DECLARE ts bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
        b  bytea  := uuid_send(gen_random_uuid());
BEGIN
  b := overlay(b PLACING substring(int8send(ts) FROM 3) FROM 1 FOR 6);
  b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112);   -- version 7
  RETURN encode(b, 'hex')::uuid;
END $$;

CREATE FUNCTION platform.current_tenant() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE FUNCTION platform.current_user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
CREATE FUNCTION platform.current_branch() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.branch_id', true), '')::uuid $$;

-- Indian financial year label for a date: 2026-10-20 -> '2026-27'
CREATE FUNCTION platform.fy_of(d date) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN extract(month FROM d) >= 4
              THEN extract(year FROM d)::int || '-' || lpad(((extract(year FROM d)::int + 1) % 100)::text, 2, '0')
              ELSE (extract(year FROM d)::int - 1) || '-' || lpad((extract(year FROM d)::int % 100)::text, 2, '0') END $$;

CREATE FUNCTION platform.forbid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% on %.% is not allowed (append-only / INV-3/INV-4)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME; END $$;

-- Optimistic concurrency (N11): editable platform/branding tables carry `version int`. The trigger increments it on
-- every UPDATE and rejects client-supplied changes; the app updates with `WHERE id = $1 AND version = $expected`
-- and treats 0 rows as a conflict.
CREATE FUNCTION platform.bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'version is maintained by the database (optimistic concurrency)';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;

-- Domains (precision rules)
CREATE DOMAIN platform.weight_g AS numeric(12,3) CHECK (VALUE >= 0);     -- grams, 3 dp (all weight columns)
CREATE DOMAIN platform.money    AS numeric(14,2);                         -- INR, 2 dp (paise exact)
CREATE DOMAIN platform.fineness AS numeric(6,3) CHECK (VALUE > 0 AND VALUE <= 1000); -- 916.000, 999.900
CREATE DOMAIN platform.pct      AS numeric(7,3);
CREATE DOMAIN platform.state_code AS char(2) CHECK (VALUE ~ '^[0-9]{2}$');           -- GST state code ('33' = TN)
CREATE DOMAIN platform.gstin    AS varchar(15) CHECK (VALUE ~ '^[0-9]{2}[A-Z0-9]{13}$');

-- ---------- partners (resellers / white-label owners) & tenancy ----------
CREATE FUNCTION platform.current_partner() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.partner_id', true), '')::uuid $$;

CREATE TABLE platform.partner (            -- reseller / white-label partner; owns many tenants
  id            uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  slug          text NOT NULL UNIQUE,
  legal_name    text NOT NULL,
  gstin         platform.gstin,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.tenant (
  id            uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  partner_id    uuid REFERENCES platform.partner(id),   -- NULL = sold directly by the platform
  slug          text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  deployment_mode text NOT NULL DEFAULT 'shared' CHECK (deployment_mode IN ('shared','dedicated','onprem')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('trial','active','read_only','suspended')),
  default_language text NOT NULL DEFAULT 'en' CHECK (default_language ~ '^[a-z]{2}(-[A-Z]{2})?$'),   -- UI language (en, ta, hi, ...)
  suspended_at  timestamptz, suspend_reason text,           -- P23 admin console
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'suspended') = (suspended_at IS NOT NULL))
);

-- P23: platform operators (our staff) using the admin console; not tenant users, no tenant_id.
CREATE TABLE platform.platform_admin (
  id            uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  name          text NOT NULL,
  password_hash text NOT NULL,             -- argon2id
  mfa_secret_enc bytea,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_partner_idx ON platform.tenant (partner_id);

CREATE TABLE platform.company (            -- legal entity / GSTIN holder
  tenant_id   uuid NOT NULL REFERENCES platform.tenant(id),
  id          uuid NOT NULL DEFAULT platform.uuid_v7(),
  legal_name  text NOT NULL,
  trade_name  text,
  gstin       platform.gstin,
  pan         varchar(10),
  state_code  platform.state_code NOT NULL,
  address     jsonb NOT NULL DEFAULT '{}',
  bank_accounts jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE platform.branch (             -- place of business; invoice series is per branch
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL DEFAULT platform.uuid_v7(),
  company_id  uuid NOT NULL,
  code        varchar(10) NOT NULL,
  name        text NOT NULL,
  bill_series_prefix varchar(12) NOT NULL CHECK (bill_series_prefix ~ '^[A-Z0-9][A-Z0-9/-]{0,11}$'),   -- e.g. 'CBE'; app builds doc_series.prefix from it
  gstin       platform.gstin,              -- optional; only for an out-of-state branch (else company GSTIN)
  state_code  platform.state_code NOT NULL,
  address     jsonb NOT NULL DEFAULT '{}',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company(tenant_id, id)
);

CREATE TABLE platform.licence (            -- on-prem / dedicated signed licence (Ed25519)
  tenant_id   uuid NOT NULL REFERENCES platform.tenant(id),
  id          uuid NOT NULL DEFAULT platform.uuid_v7(),
  licence_json jsonb NOT NULL,
  signature   bytea NOT NULL,
  valid_from  date NOT NULL,
  valid_to    date NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

-- P11-P13 settings: platform default per key (seeded in 045), overridable per tenant (or branch) in platform.setting.
CREATE TABLE platform.setting_default (
  key          text PRIMARY KEY CHECK (key ~ '^[a-z_]+(\.[a-z_]+)+$'),
  value        jsonb NOT NULL,
  value_type   text NOT NULL CHECK (value_type IN ('boolean','integer','number','text')),
  tenant_overridable boolean NOT NULL DEFAULT true,
  description  text NOT NULL
);
CREATE FUNCTION platform.setting_type_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = platform, pg_temp AS $$
DECLARE d platform.setting_default;
BEGIN
  SELECT * INTO d FROM platform.setting_default WHERE key = NEW.key;
  IF NOT d.tenant_overridable THEN RAISE EXCEPTION 'setting % is not tenant-overridable', NEW.key; END IF;
  IF jsonb_typeof(NEW.value) <> (CASE d.value_type WHEN 'boolean' THEN 'boolean' WHEN 'text' THEN 'string' ELSE 'number' END)
     OR (d.value_type = 'integer' AND NEW.value::text !~ '^-?[0-9]+$') THEN
    RAISE EXCEPTION 'setting % expects %, got %', NEW.key, d.value_type, NEW.value;
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE platform.setting (            -- tenant override (branch_id NULL) or branch override
  tenant_id  uuid NOT NULL REFERENCES platform.tenant(id),
  id         uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id  uuid,
  key        text NOT NULL REFERENCES platform.setting_default(key),   -- only known keys
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id)
);
CREATE TRIGGER setting_type_check BEFORE INSERT OR UPDATE ON platform.setting FOR EACH ROW EXECUTE FUNCTION platform.setting_type_check();
CREATE UNIQUE INDEX setting_key_uq ON platform.setting (tenant_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

-- ---------- users, roles, permissions ----------
CREATE TABLE platform.permission (         -- global catalogue (same for all tenants; no tenant_id by design)
  code        text PRIMARY KEY,            -- 'sales.invoice.issue', 'sales.invoice.cancel', 'inventory.tag.view_cost'
  module      text NOT NULL,
  description text NOT NULL
);

CREATE TABLE platform.app_user (
  tenant_id   uuid NOT NULL REFERENCES platform.tenant(id),
  id          uuid NOT NULL DEFAULT platform.uuid_v7(),
  name        text NOT NULL,
  username    text CHECK (username = lower(username) AND username ~ '^[a-z0-9._-]{3,40}$'),   -- P8 login by username or mobile
  phone       varchar(15) CHECK (phone ~ '^[0-9]{10,15}$'),
  email       text,
  password_hash text,                      -- argon2id
  mfa_secret_enc bytea,
  staff_id    uuid,                        -- FK added in 060_hr
  default_branch_id uuid,
  language    text CHECK (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),   -- NULL = tenant default_language
  is_active   boolean NOT NULL DEFAULT true,
  failed_logins int NOT NULL DEFAULT 0, locked_until timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (username IS NOT NULL OR phone IS NOT NULL),
  FOREIGN KEY (tenant_id, default_branch_id) REFERENCES platform.branch(tenant_id, id)
);
CREATE UNIQUE INDEX app_user_phone_uq ON platform.app_user (tenant_id, phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX app_user_username_uq ON platform.app_user (tenant_id, username) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX app_user_email_uq ON platform.app_user (tenant_id, lower(email)) WHERE email IS NOT NULL;

-- P5/P7: preset (system) roles and their permissions are a global catalogue. P6 custom roles are DEFERRED:
-- a tenant role must point at a system role, and there is no per-tenant permission table yet.
CREATE TABLE platform.system_role (
  code        text PRIMARY KEY CHECK (code IN ('owner','manager','salesperson','cashier')),
  name        text NOT NULL,
  rank        smallint NOT NULL UNIQUE
);
CREATE TABLE platform.system_role_permission (
  role_code   text NOT NULL REFERENCES platform.system_role(code),
  permission_code text NOT NULL REFERENCES platform.permission(code),
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE platform.role (               -- the tenant's instance of a system role (display name may be localised)
  tenant_id  uuid NOT NULL REFERENCES platform.tenant(id),
  id         uuid NOT NULL DEFAULT platform.uuid_v7(),
  name       text NOT NULL,
  system_role_code text NOT NULL REFERENCES platform.system_role(code),   -- NOT NULL until P6 (custom roles)
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, system_role_code)
);

CREATE TABLE platform.user_role (          -- branch_id NULL = all branches
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL DEFAULT platform.uuid_v7(),
  user_id    uuid NOT NULL,
  role_id    uuid NOT NULL,
  branch_id  uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES platform.app_user(tenant_id, id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES platform.role(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id)
);
CREATE UNIQUE INDEX user_role_uq ON platform.user_role (tenant_id, user_id, role_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- P10: counter device registry. Only 'approved' devices may open a billing session (app guard on login and on
-- every sales write); revoking a device revokes its live sessions (trigger below).
CREATE TABLE platform.device (
  tenant_id   uuid NOT NULL REFERENCES platform.tenant(id),
  id          uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id   uuid NOT NULL,
  name        text NOT NULL,                       -- 'Counter 1'
  kind        text NOT NULL DEFAULT 'billing_counter' CHECK (kind IN ('billing_counter','tablet','mobile','back_office')),
  fingerprint_hash bytea NOT NULL,                 -- hash of the device key generated on first launch
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','revoked')),
  requested_by uuid, approved_by uuid, approved_at timestamptz,
  revoked_by  uuid, revoked_at timestamptz, revoke_reason text,
  last_seen_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, fingerprint_hash),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id),
  CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE TABLE platform.user_session (
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL DEFAULT platform.uuid_v7(),
  user_id    uuid NOT NULL,
  device_id  uuid,
  auth_method text NOT NULL DEFAULT 'password' CHECK (auth_method IN ('password','otp')),
  token_hash bytea NOT NULL,                       -- sha256 of the opaque session token; the token itself is never stored
  ip         inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz, revoke_reason text,     -- 'logout','idle_timeout','device_revoked','admin'
  PRIMARY KEY (tenant_id, id),
  UNIQUE (token_hash),
  FOREIGN KEY (tenant_id, user_id) REFERENCES platform.app_user(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES platform.device(tenant_id, id)
);
CREATE INDEX user_session_live_idx ON platform.user_session (tenant_id, user_id) WHERE revoked_at IS NULL;
-- P11 idle timeout: the app treats a session as dead when now() - last_seen_at > auth.session_timeout_minutes
-- (platform.setting / setting_default) and stamps revoked_at with reason 'idle_timeout'.

CREATE FUNCTION platform.device_revoked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE platform.user_session SET revoked_at = now(), revoke_reason = 'device_revoked'
   WHERE tenant_id = NEW.tenant_id AND device_id = NEW.id AND revoked_at IS NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER device_revoked AFTER UPDATE OF status ON platform.device FOR EACH ROW
  WHEN (NEW.status = 'revoked' AND OLD.status <> 'revoked') EXECUTE FUNCTION platform.device_revoked();

-- P9: OTP login challenges (SMS or WhatsApp). Code stored hashed; single use; max 5 attempts.
CREATE TABLE platform.otp_challenge (
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL DEFAULT platform.uuid_v7(),
  user_id     uuid NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('sms','whatsapp')),
  code_hash   bytea NOT NULL CHECK (octet_length(code_hash) = 32),   -- HMAC-SHA256 of the code; the code itself is never stored
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  attempts    smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  consumed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES platform.app_user(tenant_id, id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes')
);

-- P21: data import (CSV/Excel) with dry run. Files live in object storage; errors in an error-report file.
CREATE TABLE platform.import_job (
  tenant_id   uuid NOT NULL REFERENCES platform.tenant(id),
  id          uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id   uuid,
  kind        text NOT NULL CHECK (kind IN ('customers','stock','opening_balances')),
  template_version int NOT NULL DEFAULT 1,
  file_key    text NOT NULL,                       -- object-storage key, never a blob
  dry_run     boolean NOT NULL DEFAULT true,
  dry_run_of  uuid,                                -- the successful dry run this real import repeats
  status      text NOT NULL DEFAULT 'uploaded'
              CHECK (status IN ('uploaded','validating','validated','failed','importing','completed','cancelled')),
  total_rows  int, ok_rows int, error_rows int,
  error_report_key text,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz, finished_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id),
  FOREIGN KEY (tenant_id, dry_run_of) REFERENCES platform.import_job(tenant_id, id),
  CHECK (dry_run OR dry_run_of IS NOT NULL),                     -- a real import must follow a dry run
  CHECK (NOT dry_run OR status NOT IN ('importing','completed')) -- a dry run never writes data
);

-- Authorisation (permission checks) is done in the NestJS guards, not in the DB.

-- P15: 10-step wizard to the first bill (resumable: progress rows per tenant). Device registration is NOT a
-- step: a counter device is registered (pending) at a user's first login on it and approved by the owner/manager.
CREATE TABLE platform.onboarding_step (
  code        text PRIMARY KEY,
  seq         smallint NOT NULL UNIQUE CHECK (seq BETWEEN 1 AND 10),
  title       text NOT NULL,
  optional    boolean NOT NULL DEFAULT false,
  required_for_billing boolean NOT NULL DEFAULT false,   -- all of these completed => billing unlocked
  CHECK (NOT (optional AND required_for_billing))
);
INSERT INTO platform.onboarding_step(code, seq, title, optional, required_for_billing) VALUES
 ('shop_profile',      1, 'Shop name, PAN, address', false, true),
 ('gst',               2, 'GSTIN and state', false, true),
 ('branches',          3, 'More branches (branch GSTIN optional, only for an out-of-state branch)', true, false),
 ('metals_purities',   4, 'Metals and purities', false, true),
 ('gst_rates',         5, 'GST rates (accept platform defaults or override)', false, true),
 ('todays_rates',      6, 'Today''s metal rates', false, true),
 ('users_roles',       7, 'Staff users and roles', false, false),
 ('branding',          8, 'Logo and colours', false, false),
 ('printers_language', 9, 'Printers, print templates and language', false, false),
 ('import',           10, 'Import customers / stock / balances (CSV/Excel, dry run first)', false, false);

CREATE TABLE platform.onboarding_progress (
  tenant_id    uuid NOT NULL REFERENCES platform.tenant(id),
  id           uuid NOT NULL DEFAULT platform.uuid_v7(),
  step         text NOT NULL REFERENCES platform.onboarding_step(code),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','skipped')),
  completed_at timestamptz,
  details      jsonb NOT NULL DEFAULT '{}',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, step),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

-- ---------- audit log (INV-3): append-only, per-tenant gapless seq + sha256 hash chain ----------
CREATE TABLE platform.audit_chain_head (
  tenant_id  uuid PRIMARY KEY REFERENCES platform.tenant(id),
  last_seq   bigint NOT NULL DEFAULT 0,
  last_hash  bytea  NOT NULL DEFAULT '\x00'::bytea
);

CREATE TABLE platform.audit_event (
  tenant_id   uuid NOT NULL,
  seq         bigint NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  user_id     uuid,
  branch_id   uuid,
  ip          inet,
  action      text NOT NULL,               -- INSERT/UPDATE/DELETE or semantic: 'invoice.print', 'login', 'export'
  table_name  text,
  row_id      uuid,
  old_row     jsonb,
  new_row     jsonb,
  prev_hash   bytea NOT NULL,
  hash        bytea NOT NULL,
  PRIMARY KEY (tenant_id, seq)
);
CREATE INDEX audit_event_row_idx ON platform.audit_event (tenant_id, table_name, row_id);
CREATE INDEX audit_event_time_idx ON platform.audit_event (tenant_id, occurred_at);
CREATE TRIGGER audit_event_no_update BEFORE UPDATE OR DELETE ON platform.audit_event
  FOR EACH ROW EXECUTE FUNCTION platform.forbid();
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON platform.audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION platform.forbid();

-- Append one event. Kept as a DB function because the hash chain must be computed under the per-tenant
-- chain-head lock by a single writer (platform_writer); used by the row trigger and by the API for
-- semantic events (print/reprint/login/export).
CREATE FUNCTION platform.audit_append(p_tenant uuid, p_action text, p_table text, p_row uuid,
                                      p_old jsonb, p_new jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = platform, pg_temp AS $$
DECLARE h platform.audit_chain_head; v_seq bigint; v_hash bytea; v_ip inet; v_canon text; v_ts timestamptz := clock_timestamp();
BEGIN
  IF p_tenant IS DISTINCT FROM platform.current_tenant() THEN
    RAISE EXCEPTION 'audit tenant mismatch';
  END IF;
  INSERT INTO platform.audit_chain_head(tenant_id) VALUES (p_tenant) ON CONFLICT DO NOTHING;
  SELECT * INTO h FROM platform.audit_chain_head WHERE tenant_id = p_tenant FOR UPDATE;  -- serialises per tenant
  v_seq := h.last_seq + 1;
  v_ip  := nullif(current_setting('app.ip', true), '')::inet;
  v_canon := jsonb_build_object('t', p_tenant, 's', v_seq, 'at', v_ts, 'u', platform.current_user_id(),
                                'b', platform.current_branch(), 'a', p_action, 'tb', p_table, 'r', p_row,
                                'o', p_old, 'n', p_new)::text;
  v_hash := sha256(h.last_hash || convert_to(v_canon, 'UTF8'));
  INSERT INTO platform.audit_event(tenant_id, seq, occurred_at, user_id, branch_id, ip, action, table_name, row_id,
                                   old_row, new_row, prev_hash, hash)
  VALUES (p_tenant, v_seq, v_ts, platform.current_user_id(), platform.current_branch(), v_ip, p_action, p_table,
          p_row, p_old, p_new, h.last_hash, v_hash);
  UPDATE platform.audit_chain_head SET last_seq = v_seq, last_hash = v_hash WHERE tenant_id = p_tenant;
  RETURN v_seq;
END $$;

CREATE FUNCTION platform.audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = platform, pg_temp AS $$
DECLARE o jsonb; n jsonb;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN o := to_jsonb(OLD); END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN n := to_jsonb(NEW); END IF;
  PERFORM platform.audit_append((coalesce(n, o)->>'tenant_id')::uuid, TG_OP,
                                TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
                                (coalesce(n, o)->>'id')::uuid, o, n);
  RETURN NULL;
END $$;

-- Verify a tenant's chain; returns the first broken seq or NULL if intact.
CREATE FUNCTION platform.audit_verify(p_tenant uuid) RETURNS bigint
LANGUAGE plpgsql STABLE SET search_path = platform, pg_temp AS $$
DECLARE e record; prev bytea := '\x00'::bytea; expect bigint := 1;
BEGIN
  FOR e IN SELECT * FROM platform.audit_event WHERE tenant_id = p_tenant ORDER BY seq LOOP
    IF e.seq <> expect OR e.prev_hash <> prev OR e.hash <> sha256(prev || convert_to(
         jsonb_build_object('t', e.tenant_id, 's', e.seq, 'at', e.occurred_at, 'u', e.user_id, 'b', e.branch_id,
                            'a', e.action, 'tb', e.table_name, 'r', e.row_id, 'o', e.old_row, 'n', e.new_row)::text,
         'UTF8')) THEN
      RETURN e.seq;
    END IF;
    prev := e.hash; expect := expect + 1;
  END LOOP;
  RETURN NULL;
END $$;

ALTER FUNCTION platform.audit_append(uuid,text,text,uuid,jsonb,jsonb) OWNER TO platform_writer;
ALTER FUNCTION platform.audit_row() OWNER TO platform_writer;

-- Attach row-level audit to a table (used by every module migration)
CREATE FUNCTION platform.enable_audit(p_table regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION platform.audit_row()', p_table);
END $$;

SELECT platform.enable_audit('platform.role');
SELECT platform.enable_audit('platform.device');
SELECT platform.enable_audit('platform.import_job');
SELECT platform.enable_audit('platform.user_role');
SELECT platform.enable_audit('platform.app_user');
SELECT platform.enable_audit('platform.setting');
SELECT platform.enable_audit('platform.branch');

INSERT INTO platform.permission(code, module, description) VALUES
 ('sales.invoice.issue','sales','Issue tax invoice'),
 ('sales.invoice.cancel','sales','Cancel invoice via credit note'),
 ('sales.return.issue','sales','Issue sales-return credit note'),
 ('sales.price.override_min','sales','Bill below tag minimum (needs approval)'),
 ('inventory.tag.view_cost','inventory','See purchase cost'),
 ('inventory.transfer.approve','inventory','Approve branch stock transfer'),
 ('rates.publish','rates','Publish daily metal rates'),
 ('approvals.decide','approvals','Approve/deny approval requests'),
 ('reports.view','reports','View reports'),
 ('sales.discount.give','sales','Give a discount on a bill'),
 ('rates.edit','rates','Edit published rates'),
 ('platform.users.manage','platform','Manage users'),
 ('platform.devices.approve','platform','Approve / revoke counter devices'),
 ('platform.settings.edit','platform','Edit shop settings'),
 ('platform.import.run','platform','Run data imports');
-- P22 data export is DEFERRED: no export permission until it is built.

INSERT INTO platform.system_role(code, name, rank) VALUES
 ('owner','Owner',1),('manager','Manager',2),('salesperson','Salesperson',3),('cashier','Cashier',4);
INSERT INTO platform.system_role_permission(role_code, permission_code)
SELECT 'owner', code FROM platform.permission
UNION ALL SELECT 'manager', unnest(ARRAY['sales.invoice.issue','sales.invoice.cancel','sales.return.issue','sales.discount.give',
       'sales.price.override_min','inventory.tag.view_cost','inventory.transfer.approve','rates.publish','approvals.decide','reports.view',
       'platform.devices.approve','platform.import.run'])
UNION ALL SELECT 'salesperson', unnest(ARRAY['sales.invoice.issue'])
UNION ALL SELECT 'cashier', unnest(ARRAY['sales.invoice.issue','sales.return.issue']);

-- P15: billing is unlocked once every required_for_billing step is completed (read-only, caller's RLS applies)
CREATE VIEW platform.v_billing_unlocked WITH (security_invoker = true) AS
SELECT t.id AS tenant_id,
       coalesce(array_agg(s.code ORDER BY s.seq) FILTER (WHERE p.status IS DISTINCT FROM 'completed'), '{}') AS missing_steps,
       bool_and(p.status IS NOT DISTINCT FROM 'completed') AS billing_unlocked
FROM platform.tenant t
CROSS JOIN platform.onboarding_step s
LEFT JOIN platform.onboarding_progress p ON p.tenant_id = t.id AND p.step = s.code
WHERE s.required_for_billing
GROUP BY t.id;

-- ---------- partner (reseller) users and sessions; platform admin sessions ----------
CREATE TABLE platform.partner_user (
  partner_id  uuid NOT NULL REFERENCES platform.partner(id),
  id          uuid NOT NULL DEFAULT platform.uuid_v7(),
  name        text NOT NULL,
  email       text NOT NULL CHECK (email = lower(email)),
  password_hash text NOT NULL,             -- argon2id
  role        text NOT NULL DEFAULT 'partner_staff' CHECK (role IN ('partner_admin','partner_staff')),
  is_active   boolean NOT NULL DEFAULT true,
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_id, id),
  UNIQUE (partner_id, email)
);
CREATE TABLE platform.partner_session (
  partner_id  uuid NOT NULL,
  id          uuid NOT NULL DEFAULT platform.uuid_v7(),
  partner_user_id uuid NOT NULL,
  token_hash  bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),   -- sha256 of the opaque token
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz, revoke_reason text,
  PRIMARY KEY (partner_id, id),
  FOREIGN KEY (partner_id, partner_user_id) REFERENCES platform.partner_user(partner_id, id)
);
CREATE TABLE platform.platform_admin_session (
  id          uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  admin_id    uuid NOT NULL REFERENCES platform.platform_admin(id),
  token_hash  bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);

-- ---------- OTP delivery (N8 of this round): no plaintext code anywhere in the DB ----------
-- otp_challenge holds only an HMAC/sha256 of the code. The code to send is put in otp_delivery as ciphertext
-- (AES-GCM by the app, key from the app's secret store, never in the DB; key_id for rotation). The pg-boss worker
-- decrypts in memory, sends, and DELETEs the row. Rows expire within 10 minutes.
CREATE TABLE platform.otp_delivery (
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL DEFAULT platform.uuid_v7(),
  otp_challenge_id uuid NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('sms','whatsapp')),
  key_id      text NOT NULL CHECK (key_id ~ '^[a-z0-9._-]{1,40}$'),
  ciphertext  bytea NOT NULL,              -- nonce(12) || ciphertext || tag(16): >= 28 bytes, never a bare digit string
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, otp_challenge_id) REFERENCES platform.otp_challenge(tenant_id, id) ON DELETE CASCADE,
  CHECK (octet_length(ciphertext) >= 28),
  CHECK (encode(ciphertext, 'hex') !~ '^([2-7][0-9a-f]|0a|0d|09)*$'),   -- reject printable text (a readable code/message)
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);

-- ---------- import errors and mapping profiles ----------
CREATE TABLE platform.import_row_error (
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL DEFAULT platform.uuid_v7(),
  import_job_id uuid NOT NULL,
  row_no      int NOT NULL CHECK (row_no >= 1),
  column_name text,
  code        text NOT NULL,               -- 'required','invalid_huid','duplicate','unknown_purity', ...
  message     text NOT NULL,
  raw         jsonb,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, import_job_id) REFERENCES platform.import_job(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX import_row_error_job_idx ON platform.import_row_error (tenant_id, import_job_id, row_no);

CREATE TABLE platform.import_mapping_profile (   -- saved column mapping for a shop's spreadsheet layout
  tenant_id   uuid NOT NULL REFERENCES platform.tenant(id),
  id          uuid NOT NULL DEFAULT platform.uuid_v7(),
  kind        text NOT NULL CHECK (kind IN ('customers','stock','opening_balances')),
  name        text NOT NULL,
  mapping     jsonb NOT NULL,              -- {"source column": "target field", ...}
  options     jsonb NOT NULL DEFAULT '{}', -- header row, date format, sheet name
  version     int NOT NULL DEFAULT 1,
  created_by  uuid, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, kind, name)
);
