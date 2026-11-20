-- 015_branding.sql — white-labelling: themes (platform -> partner -> tenant), custom domains,
-- versioned print templates, notification sender configs. Assets are object-storage KEYS, never blobs.
-- Exception to "tenant_id first in PK": platform/partner-level rows have no tenant, so these tables use
-- a surrogate PK + scope columns, guarded by scope CHECKs and scope-aware RLS (see 900_security.sql).
SET search_path = branding, platform, public;

CREATE TABLE branding.theme (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  scope        text NOT NULL CHECK (scope IN ('platform','partner','tenant')),
  partner_id   uuid REFERENCES platform.partner(id),
  tenant_id    uuid REFERENCES platform.tenant(id),
  app_name     text,                    -- NULL = inherit from next level up
  logo_key     text, favicon_key text, pwa_icon_key text, login_bg_key text,   -- e.g. 's3://brand/<id>/logo.svg'
  colors       jsonb NOT NULL DEFAULT '{}',   -- design tokens {"primary":"#8a1538","accent":"#d4af37",...}; merged key-wise
  fonts        jsonb NOT NULL DEFAULT '{}',   -- {"heading":"Poppins","body":"Inter","tamil":"Noto Sans Tamil"}
  login_text   jsonb NOT NULL DEFAULT '{}',   -- {"en":{"title":..,"subtitle":..},"ta":{...}}
  support_contact jsonb NOT NULL DEFAULT '{}',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'platform' AND partner_id IS NULL AND tenant_id IS NULL)
      OR (scope = 'partner'  AND partner_id IS NOT NULL AND tenant_id IS NULL)
      OR (scope = 'tenant'   AND tenant_id IS NOT NULL AND partner_id IS NULL)),
  CHECK (coalesce(logo_key,'') !~ '^data:' AND coalesce(favicon_key,'') !~ '^data:' AND coalesce(pwa_icon_key,'') !~ '^data:')
);
CREATE UNIQUE INDEX theme_platform_uq ON branding.theme ((true)) WHERE scope = 'platform';
CREATE UNIQUE INDEX theme_partner_uq  ON branding.theme (partner_id) WHERE scope = 'partner';
CREATE UNIQUE INDEX theme_tenant_uq   ON branding.theme (tenant_id)  WHERE scope = 'tenant';

CREATE TABLE branding.custom_domain (
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  hostname     text NOT NULL CHECK (hostname = lower(hostname) AND hostname ~ '^[a-z0-9.-]+$'),
  partner_id   uuid REFERENCES platform.partner(id),
  tenant_id    uuid REFERENCES platform.tenant(id),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','failed')),
  verification_token text NOT NULL DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  verified_at  timestamptz, last_checked_at timestamptz, failure_reason text,
  tls_status   text NOT NULL DEFAULT 'none' CHECK (tls_status IN ('none','issuing','active','failed','expired')),  -- P17 automatic HTTPS
  tls_expires_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(partner_id, tenant_id) = 1),
  CHECK (status <> 'verified' OR verified_at IS NOT NULL),
  CHECK (tls_status IN ('none','failed') OR status = 'verified'),     -- certificates only for verified hosts
  CHECK (tls_status <> 'active' OR tls_expires_at IS NOT NULL)
);
CREATE UNIQUE INDEX custom_domain_host_uq ON branding.custom_domain (hostname);

-- Print templates are branding: platform default -> partner default (for all its shops) -> shop override.
-- The app resolves per doc_type: the shop's active row, else its partner's active row, else the platform's.
CREATE TABLE branding.print_template (    -- versioned, one active version per (owner, doc_type)
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  scope        text NOT NULL CHECK (scope IN ('platform','partner','tenant')),
  partner_id   uuid REFERENCES platform.partner(id),
  tenant_id    uuid REFERENCES platform.tenant(id),
  doc_type     text NOT NULL CHECK (doc_type IN ('invoice','estimate','tag_label','receipt','credit_note','order_receipt')),
  version      int NOT NULL CHECK (version >= 1),
  paper        text NOT NULL DEFAULT 'A4' CHECK (paper IN ('A4','A5','thermal_80mm','label')),
  print_language text NOT NULL DEFAULT 'en' CHECK (print_language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  numeral_system text NOT NULL DEFAULT 'latin' CHECK (numeral_system IN ('latin','devanagari','tamil','telugu','kannada','malayalam','bengali','gujarati')),
  -- per-print override of language/numerals is an app-level render parameter (not stored)
  engine       text NOT NULL DEFAULT 'handlebars',
  body_key     text NOT NULL,           -- object-storage key of the template source
  config       jsonb NOT NULL DEFAULT '{}',
  is_active    boolean NOT NULL DEFAULT false,
  created_by   uuid, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'platform' AND partner_id IS NULL AND tenant_id IS NULL)
      OR (scope = 'partner'  AND partner_id IS NOT NULL AND tenant_id IS NULL)
      OR (scope = 'tenant'   AND tenant_id IS NOT NULL AND partner_id IS NULL))
);
CREATE UNIQUE INDEX print_template_version_uq ON branding.print_template
  (scope, coalesce(partner_id, tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), doc_type, version);
CREATE UNIQUE INDEX print_template_one_active ON branding.print_template
  (scope, coalesce(partner_id, tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), doc_type) WHERE is_active;

-- P18 (own SMS sender ID / WhatsApp number) is DEFERRED ('Later' in the feature freeze). The table is kept so
-- the shape is settled, but the app does not read it yet; messages go out under the platform/partner sender.
CREATE TABLE branding.sender_config (     -- partner default, tenant override
  id           uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  scope        text NOT NULL CHECK (scope IN ('partner','tenant')),
  partner_id   uuid REFERENCES platform.partner(id),
  tenant_id    uuid REFERENCES platform.tenant(id),
  whatsapp_number text, whatsapp_waba_id text, whatsapp_phone_number_id text,
  sms_dlt_entity_id text, sms_sender_id varchar(6),
  sms_dlt_template_ids jsonb NOT NULL DEFAULT '{}',   -- {"bill":"1107...","otp":"1107..."}
  email_from_address text, email_from_name text,
  credentials_ref text,                 -- pointer to secret store; never the secret itself
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'partner' AND partner_id IS NOT NULL AND tenant_id IS NULL)
      OR (scope = 'tenant'  AND tenant_id IS NOT NULL AND partner_id IS NULL))
);
CREATE UNIQUE INDEX sender_partner_uq ON branding.sender_config (partner_id) WHERE scope = 'partner';
CREATE UNIQUE INDEX sender_tenant_uq  ON branding.sender_config (tenant_id)  WHERE scope = 'tenant';

-- Resolution (tenant -> partner -> platform), sender override, host lookup and template activation
-- are app-layer responsibilities (see README "App-layer responsibilities"). The DB only guarantees
-- scope integrity (CHECKs), unique hostnames, one active template per type, and scope-aware RLS.

-- shop-level template changes go into the shop's audit chain; partner/platform rows have no tenant chain
CREATE TRIGGER zz_audit AFTER INSERT OR UPDATE ON branding.print_template FOR EACH ROW
  WHEN (NEW.tenant_id IS NOT NULL) EXECUTE FUNCTION platform.audit_row();
CREATE TRIGGER zz_audit_del AFTER DELETE ON branding.print_template FOR EACH ROW
  WHEN (OLD.tenant_id IS NOT NULL) EXECUTE FUNCTION platform.audit_row();
