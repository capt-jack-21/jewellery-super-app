-- 930_masters_v15_v18.sql — customer PAN key id + checks (v1.5), vendor bank_accounts jsonb -> masters.bank_account (v1.8).
-- NOTE for existing data: the new CHECKs validate existing rows (a customer with pan_enc but no pan_key_id fails the
-- migration, which then rolls back). Grants / RLS for bank_account come from 960.

-- ---------- customer PAN: ciphertext + key id + last4, all or none ----------
ALTER TABLE masters.customer
  ADD COLUMN pan_key_id text CONSTRAINT customer_pan_key_id_check CHECK (pan_key_id ~ '^[a-z0-9._-]{1,40}$'),
  ADD CONSTRAINT customer_pan_last4_check     CHECK (pan_last4 ~ '^[0-9A-Z]{4}$'),
  ADD CONSTRAINT customer_aadhaar_last4_check CHECK (aadhaar_last4 ~ '^[0-9]{4}$'),
  ADD CONSTRAINT customer_pan_all_or_none     CHECK ((pan_enc IS NULL) = (pan_key_id IS NULL) AND (pan_enc IS NULL) = (pan_last4 IS NULL)),
  ADD CONSTRAINT customer_pan_ciphertext      CHECK (pan_enc IS NULL OR (octet_length(pan_enc) >= 28
                                                     AND encode(pan_enc, 'hex') !~ '^([2-7][0-9a-f])*$'));   -- never readable text
COMMENT ON COLUMN masters.customer.pan_enc IS 'PAN ciphertext only (AES-GCM in the app, key outside the DB); drives Rule 114B check';

-- ---------- bank accounts (company: printed on invoices; vendor: payments) ----------
ALTER TABLE masters.vendor DROP COLUMN bank_accounts;
CREATE TABLE masters.bank_account (
  tenant_id      uuid NOT NULL REFERENCES platform.tenant(id),
  id             uuid NOT NULL DEFAULT platform.uuid_v7(),
  owner_type     text NOT NULL CHECK (owner_type IN ('company','vendor')),
  company_id     uuid,
  vendor_id      uuid,
  bank_name      text NOT NULL CHECK (length(bank_name) BETWEEN 2 AND 100),
  branch_name    text,
  ifsc           varchar(11) NOT NULL CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  holder_name    text NOT NULL CHECK (length(holder_name) BETWEEN 2 AND 140),
  account_no_enc bytea NOT NULL CHECK (octet_length(account_no_enc) >= 28
                                       AND encode(account_no_enc, 'hex') !~ '^([2-7][0-9a-f])*$'),   -- never readable text
  account_key_id text NOT NULL CHECK (account_key_id ~ '^[a-z0-9._-]{1,40}$'),
  account_last4  varchar(4) NOT NULL CHECK (account_last4 ~ '^[0-9]{4}$'),
  is_default     boolean NOT NULL DEFAULT false,          -- default account for this owner (payments)
  print_on_invoice boolean NOT NULL DEFAULT false,        -- company only: shown on invoices / estimates
  is_active      boolean NOT NULL DEFAULT true,
  version        int NOT NULL DEFAULT 1,                  -- optimistic concurrency (aa_version trigger below)
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK ((owner_type = 'company' AND company_id IS NOT NULL AND vendor_id IS NULL)
      OR (owner_type = 'vendor'  AND vendor_id IS NOT NULL AND company_id IS NULL)),
  CHECK (owner_type = 'company' OR NOT print_on_invoice),
  FOREIGN KEY (tenant_id, company_id) REFERENCES platform.company(tenant_id, id),
  FOREIGN KEY (tenant_id, vendor_id)  REFERENCES masters.vendor(tenant_id, id)
);
CREATE UNIQUE INDEX bank_account_one_default ON masters.bank_account
  (tenant_id, owner_type, coalesce(company_id, vendor_id)) WHERE is_default AND is_active;
CREATE UNIQUE INDEX bank_account_no_dup ON masters.bank_account
  (tenant_id, owner_type, coalesce(company_id, vendor_id), ifsc, account_last4, holder_name);
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON masters.bank_account FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
