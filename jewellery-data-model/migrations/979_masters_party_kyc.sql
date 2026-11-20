-- 979_masters_party_kyc.sql — M8 customers, M10 suppliers/karigars, M11 staff: KYC, encrypted PII, versioning, metal openings.
-- Exists already: customer name/phone(mobile)/address/dob/anniversary/gstin/PAN(ciphertext+key id+last4)/aadhaar_last4;
-- vendor kinds (supplier, smith = karigar, designer, ...), gstin, state_code, plaintext pan; hr.staff with PAN ciphertext;
-- accounts.account_head opening_amount/opening_pure_wt for ONE metal. Added here:
--   * customer: kyc_status/kyc_verified_at/kyc_verified_by, is_active, version (aa_version)
--   * vendor: PAN ciphertext + key id + last4 (all or none, never readable text), aadhaar_last4, version (aa_version).
--     The legacy plaintext vendor.pan stays for the app's backfill and is hidden from app_ro now; drop it in a later file.
--   * hr.staff: is_active, is_salesperson, photo_file_id (platform.file), version (aa_version)
--   * masters.kyc_document (audited, no secrets: type, last4, files, status) for customers, vendors and staff, and
--     masters.kyc_document_secret (document number ciphertext + key id; NOT row-audited because audit_event rows are
--     readable by app_ro; readable by app_rw only)
--   * accounts.party_opening_metal: per-metal/purity opening metal balance of a party ledger (karigar/supplier/customer)
-- Sensitive columns follow 960's v1.7 rule: only app_rw (and the owner) may read ciphertext and key ids.

-- ---------- customer ----------
ALTER TABLE masters.customer
  ADD COLUMN kyc_status      text NOT NULL DEFAULT 'none'
                             CONSTRAINT customer_kyc_status_check CHECK (kyc_status IN ('none','pending','verified','rejected','expired')),
  ADD COLUMN kyc_verified_at timestamptz,
  ADD COLUMN kyc_verified_by uuid,
  ADD COLUMN is_active       boolean NOT NULL DEFAULT true,
  ADD COLUMN version         int NOT NULL DEFAULT 1,
  ADD CONSTRAINT customer_kyc_verified_by_fk FOREIGN KEY (tenant_id, kyc_verified_by) REFERENCES platform.app_user(tenant_id, id),
  ADD CONSTRAINT customer_kyc_verified_consistent CHECK (kyc_status <> 'verified' OR kyc_verified_at IS NOT NULL);
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON masters.customer FOR EACH ROW EXECUTE FUNCTION platform.bump_version();

-- ---------- vendor (suppliers, karigars = kind 'smith', designers, ...) ----------
ALTER TABLE masters.vendor
  ADD COLUMN pan_enc       bytea,
  ADD COLUMN pan_key_id    text CONSTRAINT vendor_pan_key_id_check CHECK (pan_key_id ~ '^[a-z0-9._-]{1,40}$'),
  ADD COLUMN pan_last4     varchar(4) CONSTRAINT vendor_pan_last4_check CHECK (pan_last4 ~ '^[0-9A-Z]{4}$'),
  ADD COLUMN aadhaar_last4 varchar(4) CONSTRAINT vendor_aadhaar_last4_check CHECK (aadhaar_last4 ~ '^[0-9]{4}$'),
  ADD COLUMN version       int NOT NULL DEFAULT 1,
  ADD CONSTRAINT vendor_pan_all_or_none CHECK ((pan_enc IS NULL) = (pan_key_id IS NULL) AND (pan_enc IS NULL) = (pan_last4 IS NULL)),
  ADD CONSTRAINT vendor_pan_ciphertext  CHECK (pan_enc IS NULL OR (octet_length(pan_enc) >= 28 AND encode(pan_enc, 'hex') !~ '^([2-7][0-9a-f])*$'));
COMMENT ON COLUMN masters.vendor.pan IS 'LEGACY plaintext PAN: hidden from app_ro (979); app backfills pan_enc/pan_key_id/pan_last4, then a later migration drops it';
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON masters.vendor FOR EACH ROW EXECUTE FUNCTION platform.bump_version();

-- ---------- hr.staff (M11 staff / salespeople) ----------
ALTER TABLE hr.staff
  ADD COLUMN is_active      boolean NOT NULL DEFAULT true,
  ADD COLUMN is_salesperson boolean NOT NULL DEFAULT false,
  ADD COLUMN photo_file_id  uuid,
  ADD COLUMN version        int NOT NULL DEFAULT 1,
  ADD CONSTRAINT staff_photo_file_fk FOREIGN KEY (tenant_id, photo_file_id) REFERENCES platform.file(tenant_id, id);
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON hr.staff FOR EACH ROW EXECUTE FUNCTION platform.bump_version();

-- ---------- KYC documents ----------
CREATE TABLE masters.kyc_document (
  tenant_id     uuid NOT NULL REFERENCES platform.tenant(id),
  id            uuid NOT NULL DEFAULT platform.uuid_v7(),
  party_type    text NOT NULL CHECK (party_type IN ('customer','vendor','staff')),
  customer_id   uuid,
  vendor_id     uuid,
  staff_id      uuid,
  doc_type      text NOT NULL CHECK (doc_type IN ('pan','aadhaar','passport','voter_id','driving_licence','gstin_certificate','other')),
  number_last4  varchar(4) CHECK (number_last4 ~ '^[0-9A-Z]{4}$'),   -- full number only as ciphertext in kyc_document_secret
  front_file_id uuid NOT NULL,                                       -- scan/photo in platform.file (area 'attachments')
  back_file_id  uuid,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected','expired')),
  verified_at   timestamptz,
  verified_by   uuid,
  expires_on    date,
  is_active     boolean NOT NULL DEFAULT true,
  version       int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kyc_document_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT kyc_document_one_party CHECK (
       (party_type = 'customer' AND customer_id IS NOT NULL AND vendor_id IS NULL AND staff_id IS NULL)
    OR (party_type = 'vendor'   AND vendor_id IS NOT NULL AND customer_id IS NULL AND staff_id IS NULL)
    OR (party_type = 'staff'    AND staff_id IS NOT NULL AND customer_id IS NULL AND vendor_id IS NULL)),
  CONSTRAINT kyc_document_verified_consistent CHECK ((status = 'verified') = (verified_at IS NOT NULL) OR status IN ('expired')),
  CONSTRAINT kyc_document_customer_fk FOREIGN KEY (tenant_id, customer_id)   REFERENCES masters.customer(tenant_id, id),
  CONSTRAINT kyc_document_vendor_fk   FOREIGN KEY (tenant_id, vendor_id)     REFERENCES masters.vendor(tenant_id, id),
  CONSTRAINT kyc_document_staff_fk    FOREIGN KEY (tenant_id, staff_id)      REFERENCES hr.staff(tenant_id, id),
  CONSTRAINT kyc_document_front_fk    FOREIGN KEY (tenant_id, front_file_id) REFERENCES platform.file(tenant_id, id),
  CONSTRAINT kyc_document_back_fk     FOREIGN KEY (tenant_id, back_file_id)  REFERENCES platform.file(tenant_id, id),
  CONSTRAINT kyc_document_verified_by_fk FOREIGN KEY (tenant_id, verified_by) REFERENCES platform.app_user(tenant_id, id)
);
CREATE INDEX kyc_document_customer_idx ON masters.kyc_document (tenant_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX kyc_document_vendor_idx   ON masters.kyc_document (tenant_id, vendor_id)   WHERE vendor_id IS NOT NULL;
CREATE INDEX kyc_document_staff_idx    ON masters.kyc_document (tenant_id, staff_id)    WHERE staff_id IS NOT NULL;

CREATE TABLE masters.kyc_document_secret (
  tenant_id       uuid NOT NULL REFERENCES platform.tenant(id),
  kyc_document_id uuid NOT NULL,
  number_enc      bytea NOT NULL CONSTRAINT kyc_document_secret_ciphertext
                  CHECK (octet_length(number_enc) >= 28 AND encode(number_enc, 'hex') !~ '^([2-7][0-9a-f])*$'),  -- never readable text
  number_key_id   text NOT NULL CONSTRAINT kyc_document_secret_key_id_check CHECK (number_key_id ~ '^[a-z0-9._-]{1,40}$'),
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kyc_document_secret_pkey PRIMARY KEY (tenant_id, kyc_document_id),
  CONSTRAINT kyc_document_secret_doc_fk FOREIGN KEY (tenant_id, kyc_document_id) REFERENCES masters.kyc_document(tenant_id, id) ON DELETE CASCADE
);
COMMENT ON TABLE masters.kyc_document_secret IS 'KYC document number ciphertext (AES-GCM in the app); app_rw only; deliberately not row-audited';

-- ---------- per-metal opening balances (M10 balances; money opening stays on accounts.account_head) ----------
CREATE TABLE accounts.party_opening_metal (
  tenant_id       uuid NOT NULL REFERENCES platform.tenant(id),
  id              uuid NOT NULL DEFAULT platform.uuid_v7(),
  account_head_id uuid NOT NULL,
  metal_id        uuid NOT NULL,
  purity_id       uuid,                                  -- NULL = fine (pure) weight of the metal
  weight          numeric(12,3) NOT NULL,                -- grams; +dr (party owes us metal) / -cr (we owe the party)
  as_of           date NOT NULL,
  note            text,
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT party_opening_metal_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT party_opening_metal_head_fk   FOREIGN KEY (tenant_id, account_head_id) REFERENCES accounts.account_head(tenant_id, id),
  CONSTRAINT party_opening_metal_metal_fk  FOREIGN KEY (tenant_id, metal_id)        REFERENCES masters.metal(tenant_id, id),
  CONSTRAINT party_opening_metal_purity_fk FOREIGN KEY (tenant_id, purity_id)       REFERENCES masters.purity(tenant_id, id)
);
CREATE UNIQUE INDEX party_opening_metal_uq ON accounts.party_opening_metal
  (tenant_id, account_head_id, metal_id, coalesce(purity_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------- version + audit on the new tables ----------
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON masters.kyc_document        FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON masters.kyc_document_secret FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON accounts.party_opening_metal FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
SELECT platform.enable_audit('masters.kyc_document');
SELECT platform.enable_audit('accounts.party_opening_metal');
-- customer / vendor / hr.staff / kyc_document_secret stay un-audited at row level: the audit row would copy PAN/number
-- ciphertext + key id into platform.audit_event, which app_ro can read.

-- ---------- RLS on the new tables ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['masters.kyc_document','masters.kyc_document_secret','accounts.party_opening_metal'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = platform.current_tenant()) WITH CHECK (tenant_id = platform.current_tenant())', t);
    EXECUTE format('CREATE POLICY no_partner_access ON %s AS RESTRICTIVE USING (platform.current_partner() IS NULL) WITH CHECK (platform.current_partner() IS NULL)', t);
  END LOOP;
END $$;

-- ---------- grants on the new tables ----------
REVOKE ALL ON masters.kyc_document, masters.kyc_document_secret, accounts.party_opening_metal FROM PUBLIC, app_rw, app_ro, app_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON masters.kyc_document, masters.kyc_document_secret TO app_rw;
GRANT SELECT ON masters.kyc_document TO app_ro, sales_writer, inventory_writer, orders_writer, purchases_writer, refinery_writer;
-- kyc_document_secret: app_rw only (no app_ro, no writer roles)
GRANT SELECT, INSERT, UPDATE ON accounts.party_opening_metal TO app_rw;          -- accounts pattern: no DELETE
GRANT SELECT ON accounts.party_opening_metal TO app_ro, accounts_writer;

-- ---------- grants on the altered tables ----------
-- customer + hr.staff: readers already hold column-level SELECT (960 v1.7); extend it to the new non-secret columns.
-- vendor: readers hold table-level SELECT; convert to column-level without pan_enc/pan_key_id (and, for app_ro, the legacy pan).
DO $$
DECLARE r record; g record; keep text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('masters','customer', 'kyc_status, kyc_verified_at, kyc_verified_by, is_active, version'),
      ('hr','staff',         'is_active, is_salesperson, photo_file_id, version')) AS v(s, t, cols)
  LOOP
    FOR g IN SELECT DISTINCT a.grantee::regrole::text AS role
             FROM pg_attribute att, aclexplode(att.attacl) a
             WHERE att.attrelid = format('%I.%I', r.s, r.t)::regclass AND att.attname = 'name' AND a.privilege_type = 'SELECT'
               AND a.grantee <> 0 AND a.grantee::regrole::text NOT IN ('app_rw','app_migrator')
    LOOP
      EXECUTE format('GRANT SELECT (%s) ON %I.%I TO %I', r.cols, r.s, r.t, g.role);
    END LOOP;
  END LOOP;

  FOR g IN SELECT DISTINCT a.grantee::regrole::text AS role
           FROM pg_class c, aclexplode(c.relacl) a
           WHERE c.oid = 'masters.vendor'::regclass AND a.privilege_type = 'SELECT' AND a.grantee <> 0
             AND a.grantee::regrole::text NOT IN ('app_rw','app_migrator')
  LOOP
    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO keep
    FROM information_schema.columns WHERE table_schema = 'masters' AND table_name = 'vendor'
      AND column_name NOT IN ('pan_enc','pan_key_id') AND NOT (g.role = 'app_ro' AND column_name = 'pan');
    EXECUTE format('REVOKE SELECT ON masters.vendor FROM %I', g.role);
    EXECUTE format('GRANT SELECT (%s) ON masters.vendor TO %I', keep, g.role);
  END LOOP;
END $$;
