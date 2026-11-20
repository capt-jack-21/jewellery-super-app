-- 040_masters.sql — metal, purity, item/sub-item, stone standards, designer/vendor, floor/counter/box, tax, customer
SET search_path = masters, platform, public;

CREATE TABLE masters.metal (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  code varchar(10) NOT NULL, name text NOT NULL,          -- GOLD, SILVER, PLATINUM
  default_hsn varchar(8) NOT NULL,                        -- 7113 jewellery
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code)
);

CREATE TABLE masters.purity (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  metal_id uuid NOT NULL,
  code varchar(10) NOT NULL,                              -- 22K, 18K, 24K, 925
  fineness platform.fineness NOT NULL,                    -- 916.000, 750.000, 999.000, 925.000
  huid_required boolean NOT NULL DEFAULT true,            -- BIS hallmark: gold yes; silver configurable
  header_visible boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, metal_id, code),
  FOREIGN KEY (tenant_id, metal_id) REFERENCES masters.metal(tenant_id, id)
);

-- ---------- GST configuration (no rates hard-coded anywhere; seed data only) ----------
-- Platform default rules (scope='platform', tenant_id NULL) are maintained by the platform team and
-- inherited by every tenant; a tenant rule with the same (component, metal_code, hsn_sac) and an
-- overlapping period overrides it. The NestJS tax service picks the rule; invoice lines snapshot it.
CREATE TABLE masters.tax_rule (
  id             uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  scope          text NOT NULL CHECK (scope IN ('platform','tenant')),
  tenant_id      uuid REFERENCES platform.tenant(id),
  code           text NOT NULL,                      -- 'GOLD_JEWELLERY', 'MAKING_COMPOSITE', 'REPAIR_SERVICE', 'HALLMARK'
  description    text,
  component      text NOT NULL CHECK (component IN ('metal','making','stone','hallmark','service','old_metal_purchase','other')),
  metal_code     varchar(10),                        -- 'GOLD','SILVER',... NULL = any metal (code, so platform rows need no tenant FK)
  code_type      text NOT NULL CHECK (code_type IN ('HSN','SAC')),
  hsn_sac        varchar(8) NOT NULL CHECK (hsn_sac ~ '^[0-9]{4,8}$'),
  rate           numeric(5,2) NOT NULL CHECK (rate >= 0 AND rate <= 100),   -- total GST %
  cgst_rate      numeric(5,2) NOT NULL,              -- intra-state split
  sgst_rate      numeric(5,2) NOT NULL,              -- (SGST or UTGST)
  igst_rate      numeric(5,2) NOT NULL,              -- inter-state
  cess_rate      numeric(5,2) NOT NULL DEFAULT 0,
  composite_supply boolean NOT NULL DEFAULT false,   -- true: component is ancillary; taxed at the principal supply's rule
  principal_component text CHECK (principal_component IN ('metal','service')),
  reverse_charge boolean NOT NULL DEFAULT false,
  effective_from date NOT NULL,
  effective_to   date,                               -- exclusive; NULL = open-ended
  first_used_at  timestamptz,                        -- set by DB when the first invoice line references the rule (locks it)
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'platform' AND tenant_id IS NULL) OR (scope = 'tenant' AND tenant_id IS NOT NULL)),
  CHECK (cgst_rate + sgst_rate = rate AND igst_rate = rate),
  CHECK (NOT composite_supply OR principal_component IS NOT NULL),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- no two rules of the same scope may overlap in time for the same key
  EXCLUDE USING gist (
    (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    component WITH =, (coalesce(metal_code, '*')) WITH =, hsn_sac WITH =,
    daterange(effective_from, effective_to) WITH &&)
);
CREATE INDEX tax_rule_lookup_idx ON masters.tax_rule (tenant_id, component, metal_code, effective_from DESC);

-- N16 guardrails on tax rules:
--  * INSERT: effective_from >= today (Asia/Kolkata) — no back-dated rates. Exception: session_user app_migrator
--    (initial platform seed / onboarding data import), so history can be loaded once.
--  * UPDATE: once any invoice line (or line-tax row) references the rule it is immutable, except closing it by
--    setting effective_to (NULL -> date >= today, or moving a future end date, never into the past). A rate
--    change is therefore "close old rule + insert new rule"; issued invoices keep pointing at the old row.
--  * DELETE: only if unreferenced (FKs from sales.invoice_line / invoice_line_tax are ON DELETE RESTRICT).
CREATE FUNCTION masters.tax_rule_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = masters, sales, pg_temp AS $$
DECLARE v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date; v_used boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.effective_from < v_today AND session_user <> 'app_migrator' THEN
      RAISE EXCEPTION 'tax rule effective_from % is in the past (no back-dating; today is %)', NEW.effective_from, v_today;
    END IF;
    RETURN NEW;
  END IF;
  -- the lock-marker update itself (first_used_at NULL -> ts, nothing else changed)
  IF OLD.first_used_at IS NULL AND NEW.first_used_at IS NOT NULL
     AND (to_jsonb(NEW) - 'first_used_at') = (to_jsonb(OLD) - 'first_used_at') THEN
    RETURN NEW;
  END IF;
  -- first_used_at is a marker maintained by the DB (not a cross-tenant scan, which RLS would hide)
  v_used := OLD.first_used_at IS NOT NULL;
  IF NEW.first_used_at IS DISTINCT FROM OLD.first_used_at THEN RAISE EXCEPTION 'first_used_at is DB-maintained'; END IF;
  IF v_used THEN
    -- N19: the ONLY change allowed on a referenced rule is closing it: effective_to NULL -> date >= today (IST)
    IF (to_jsonb(NEW) - 'effective_to') IS DISTINCT FROM (to_jsonb(OLD) - 'effective_to')
       OR OLD.effective_to IS NOT NULL OR NEW.effective_to IS NULL OR NEW.effective_to < v_today THEN
      RAISE EXCEPTION 'tax rule % is referenced by issued invoices: only effective_to NULL -> date >= % is allowed', OLD.code, v_today;
    END IF;
  END IF;
  IF NEW.effective_to IS DISTINCT FROM OLD.effective_to AND NEW.effective_to IS NOT NULL AND NEW.effective_to < v_today THEN
    RAISE EXCEPTION 'effective_to % cannot be in the past', NEW.effective_to;
  END IF;
  IF NEW.effective_from IS DISTINCT FROM OLD.effective_from AND NEW.effective_from < v_today THEN
    RAISE EXCEPTION 'effective_from cannot be moved into the past';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_rule_guard BEFORE INSERT OR UPDATE ON masters.tax_rule FOR EACH ROW EXECUTE FUNCTION masters.tax_rule_guard();
SELECT 1;

CREATE TABLE masters.gst_config (           -- one row per tenant (per company if multi-GSTIN later)
  tenant_id      uuid NOT NULL REFERENCES platform.tenant(id),
  id             uuid NOT NULL DEFAULT platform.uuid_v7(),
  company_id     uuid,                               -- NULL = all companies of the tenant
  registration_type text NOT NULL DEFAULT 'regular' CHECK (registration_type IN ('regular','composition','unregistered')),
  tax_inclusive_pricing boolean NOT NULL DEFAULT false,
  rounding_level text NOT NULL DEFAULT 'invoice' CHECK (rounding_level IN ('line','invoice')),
  round_off_to   numeric(4,2) NOT NULL DEFAULT 1.00 CHECK (round_off_to IN (0.01, 0.10, 0.50, 1.00)),
  einvoice_enabled boolean NOT NULL DEFAULT false,
  einvoice_from  date,
  b2c_qr_required boolean NOT NULL DEFAULT false,
  effective_from date NOT NULL,
  effective_to   date,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company(tenant_id, id),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  EXCLUDE USING gist (tenant_id WITH =, (coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
                      daterange(effective_from, effective_to) WITH &&)
);
SELECT platform.enable_audit('masters.gst_config');

-- Business policies: platform default row(s) (scope='platform', seeded in 045_platform_defaults.sql) that a tenant
-- may override during onboarding with its own dated row. The app uses the tenant row in force, else the platform row.
CREATE TABLE masters.sales_policy (
  id             uuid PRIMARY KEY DEFAULT platform.uuid_v7(),
  scope          text NOT NULL CHECK (scope IN ('platform','tenant')),
  tenant_id      uuid REFERENCES platform.tenant(id),
  making_gst_treatment text NOT NULL CHECK (making_gst_treatment IN ('composite','separate')),
  making_tax_rule_code text,                 -- masters.tax_rule.code used when 'separate'
  old_gold_valuation_basis text NOT NULL CHECK (old_gold_valuation_basis IN ('stated_purity','fine_24k')),
  old_gold_excess_handling text NOT NULL CHECK (old_gold_excess_handling IN ('refund_on_bill','separate_purchase')),
  credit_note_rounding text NOT NULL CHECK (credit_note_rounding IN ('follow_invoice','exact')),
  return_settlement_default text NOT NULL CHECK (return_settlement_default IN ('store_credit','refund')),
  return_window_days int NOT NULL CHECK (return_window_days BETWEEN 0 AND 365),
  effective_from date NOT NULL,
  effective_to   date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'platform' AND tenant_id IS NULL) OR (scope = 'tenant' AND tenant_id IS NOT NULL)),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (making_gst_treatment = 'composite' OR making_tax_rule_code IS NOT NULL),
  EXCLUDE USING gist ((coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
                      daterange(effective_from, effective_to) WITH &&)
);
-- (audited via app semantic events; platform rows have no tenant for the per-tenant chain)

CREATE TABLE masters.floor (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL, name text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id)
);
CREATE TABLE masters.counter (            -- display counter (stock location); cash counters live in accounts
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL, floor_id uuid, code varchar(10) NOT NULL, name text NOT NULL,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, branch_id, code),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id),
  FOREIGN KEY (tenant_id, floor_id) REFERENCES masters.floor(tenant_id, id)
);

CREATE TABLE masters.item (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  metal_id uuid NOT NULL, purity_id uuid NOT NULL,
  code varchar(20) NOT NULL, short_code varchar(10), name text NOT NULL,
  hsn varchar(8) NOT NULL,
  stock_type text NOT NULL CHECK (stock_type IN ('tag','non_tag','packet')),
  mc_type text NOT NULL DEFAULT 'per_gram' CHECK (mc_type IN ('per_gram','percent','flat','per_piece')),
  mc_value numeric(12,2) NOT NULL DEFAULT 0,
  min_mc platform.money NOT NULL DEFAULT 0,
  wastage_type text NOT NULL DEFAULT 'percent' CHECK (wastage_type IN ('percent','weight','none')),
  wastage_value numeric(12,3) NOT NULL DEFAULT 0,       -- % when wastage_type='percent', grams when 'weight' (12,3 covers both)
  huid_charge platform.money NOT NULL DEFAULT 0,          -- hallmarking charge per piece
  default_counter_id uuid,
  allow_zero_weight boolean NOT NULL DEFAULT false,
  image_url text,
  is_active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, metal_id) REFERENCES masters.metal(tenant_id, id),
  FOREIGN KEY (tenant_id, purity_id) REFERENCES masters.purity(tenant_id, id),
  FOREIGN KEY (tenant_id, default_counter_id) REFERENCES masters.counter(tenant_id, id)
);

CREATE TABLE masters.sub_item (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  item_id uuid NOT NULL, code varchar(20) NOT NULL, name text NOT NULL,
  hsn varchar(8),
  measurement text NOT NULL DEFAULT 'gram' CHECK (measurement IN ('gram','piece','carat')),
  mc_type text CHECK (mc_type IN ('per_gram','percent','flat','per_piece')),   -- NULL = inherit item
  mc_value numeric(12,2), wastage_value numeric(12,3), huid_charge platform.money,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, item_id, code),
  FOREIGN KEY (tenant_id, item_id) REFERENCES masters.item(tenant_id, id)
);

CREATE TABLE masters.box (                -- tray per counter
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  counter_id uuid NOT NULL, sub_item_id uuid, code varchar(20) NOT NULL,
  tare_weight platform.weight_g NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, counter_id) REFERENCES masters.counter(tenant_id, id),
  FOREIGN KEY (tenant_id, sub_item_id) REFERENCES masters.sub_item(tenant_id, id)
);

CREATE TABLE masters.stone_standard (     -- shape / cut / clarity / colour / stone / cent_group
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  kind text NOT NULL CHECK (kind IN ('stone','shape','cut','clarity','colour','cent_group')),
  code varchar(20) NOT NULL, name text NOT NULL,
  cent_from numeric(8,3), cent_to numeric(8,3),           -- diamond size band in CENTS (not grams), deliberately not weight_g
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, kind, code)
);

CREATE TABLE masters.vendor (             -- designers, suppliers, refiners, repair vendors
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  code varchar(20) NOT NULL, name text NOT NULL,
  kinds text[] NOT NULL CHECK (kinds <@ ARRAY['designer','supplier','repair_vendor','smith','refiner','diamond_seller','buyer']::text[]),
  gstin platform.gstin, pan varchar(10), state_code platform.state_code,
  addresses jsonb NOT NULL DEFAULT '[]', contacts jsonb NOT NULL DEFAULT '[]', bank_accounts jsonb NOT NULL DEFAULT '[]',
  is_active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code)
);

CREATE TABLE masters.value_addition_rule (  -- customer & designer VA (wastage/MC by weight band)
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  scope text NOT NULL CHECK (scope IN ('customer','designer')),
  tier text NOT NULL DEFAULT 'retail' CHECK (tier IN ('purchase','retail','vip_retail')),
  metal_id uuid, item_id uuid, sub_item_id uuid, vendor_id uuid,
  weight_from platform.weight_g NOT NULL DEFAULT 0, weight_to platform.weight_g,
  touch platform.pct, wastage_pct platform.pct, flat_wastage platform.weight_g,
  mc_per_gram numeric(12,2), flat_mc platform.money, fixed_rate platform.money,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES masters.item(tenant_id, id),
  FOREIGN KEY (tenant_id, vendor_id) REFERENCES masters.vendor(tenant_id, id)
);

CREATE TABLE masters.diamond_rate (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  cent_group_id uuid NOT NULL, shape_id uuid, clarity_id uuid, colour_id uuid, cut_id uuid, vendor_id uuid,
  purchase_rate_per_ct platform.money, sale_rate_per_ct platform.money NOT NULL,
  effective_from date NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, cent_group_id) REFERENCES masters.stone_standard(tenant_id, id)
);

CREATE TABLE masters.repair_type (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  name text NOT NULL, sac varchar(8),
  min_customer_charge platform.money, max_customer_charge platform.money,
  min_vendor_charge platform.money, max_vendor_charge platform.money,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, name)
);

CREATE TABLE masters.customer_group (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  name text NOT NULL, PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, name)
);

CREATE TABLE masters.customer (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  name text NOT NULL, phone varchar(15), email text,
  dob date, anniversary date,
  gstin platform.gstin, state_code platform.state_code,
  pan_enc bytea,                 -- AES-GCM in the app; presence drives Rule 114B check
  pan_last4 varchar(4),
  aadhaar_last4 varchar(4),      -- never store full Aadhaar
  upi_id text, address jsonb NOT NULL DEFAULT '{}',
  group_id uuid, home_branch_id uuid,
  consent_at timestamptz,        -- DPDP consent
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, group_id) REFERENCES masters.customer_group(tenant_id, id),
  FOREIGN KEY (tenant_id, home_branch_id) REFERENCES platform.branch(tenant_id, id)
);
CREATE UNIQUE INDEX customer_phone_uq ON masters.customer (tenant_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX customer_name_idx ON masters.customer (tenant_id, lower(name));
