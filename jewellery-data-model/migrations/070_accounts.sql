-- 070_accounts.sql — account groups, heads, append-only ledger (₹ and grams), cash counters, vouchers
SET search_path = accounts, platform, public;

CREATE TABLE accounts.account_group (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  name text NOT NULL, nature text NOT NULL CHECK (nature IN ('asset','liability','income','expense','equity')),
  parent_id uuid,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES accounts.account_group(tenant_id, id)
);

CREATE TABLE accounts.account_head (       -- ledger account; party heads link to vendor/customer
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  group_id uuid NOT NULL, name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('vendor','customer','cash','bank','sales','purchase','tax','expense','income','metal_stock','other')),
  vendor_id uuid, customer_id uuid,
  opening_amount platform.money NOT NULL DEFAULT 0,       -- +dr / -cr
  opening_pure_wt numeric(12,3) NOT NULL DEFAULT 0,       -- +dr / -cr, fine grams
  opening_metal_id uuid,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, group_id) REFERENCES accounts.account_group(tenant_id, id),
  FOREIGN KEY (tenant_id, vendor_id) REFERENCES masters.vendor(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES masters.customer(tenant_id, id)
);
CREATE UNIQUE INDEX account_head_vendor_uq ON accounts.account_head (tenant_id, vendor_id) WHERE vendor_id IS NOT NULL;

CREATE TABLE accounts.cash_counter (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL, name text NOT NULL, pin_hash text,
  cash_head_id uuid,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, branch_id, name),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id),
  FOREIGN KEY (tenant_id, cash_head_id) REFERENCES accounts.account_head(tenant_id, id)
);

CREATE TABLE accounts.voucher (            -- receipt / payment / journal / contra (Phase 3 books)
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL, voucher_type text NOT NULL CHECK (voucher_type IN ('receipt','payment','journal','contra')),
  voucher_no text NOT NULL, voucher_date date NOT NULL, narration text,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, branch_id, voucher_type, voucher_no),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id)
);

-- Append-only double-entry ledger in rupees AND fine grams (vendor ledger = filter by vendor head)
CREATE TABLE accounts.ledger_entry (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL, entry_date date NOT NULL,
  account_head_id uuid NOT NULL,
  amount_dr platform.money NOT NULL DEFAULT 0, amount_cr platform.money NOT NULL DEFAULT 0,
  metal_id uuid, pure_wt_dr platform.weight_g NOT NULL DEFAULT 0, pure_wt_cr platform.weight_g NOT NULL DEFAULT 0,
  source_module text NOT NULL,              -- 'sales','purchases','refinery','accounts'
  source_type text NOT NULL, source_id uuid NOT NULL,
  voucher_id uuid, narration text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, account_head_id) REFERENCES accounts.account_head(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES accounts.voucher(tenant_id, id)
);
CREATE INDEX ledger_head_idx ON accounts.ledger_entry (tenant_id, account_head_id, entry_date);
CREATE INDEX ledger_source_idx ON accounts.ledger_entry (tenant_id, source_type, source_id);
-- append-only by grants: only accounts_writer may INSERT; nobody has UPDATE/DELETE (900_security.sql)

