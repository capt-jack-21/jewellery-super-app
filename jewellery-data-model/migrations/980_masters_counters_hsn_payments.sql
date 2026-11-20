-- 980_masters_counters_hsn_payments.sql — M12 counters/trays, M13 HSN catalogue, M14 payment modes, M15 card machines.
-- Exists already: masters.floor/counter (display counters) and masters.box (tray per counter, tare_weight);
-- accounts.cash_counter; masters.bank_account (company/vendor, number ciphertext); masters.tax_rule (all GST rates, by hsn_sac);
-- sales.invoice_payment.mode (fixed CHECK list). Added here:
--   * counter: is_active, version; box (tray): name, is_active, version
--   * masters.hsn_code: tenant HSN/SAC catalogue (description, GST UQC). NO rate columns: the rate stays in masters.tax_rule
--     (platform or tenant rule with the same hsn_sac, effective dated); the app joins on (code_type, code) = (code_type, hsn_sac).
--   * masters.payment_mode: configurable tender list; kind maps to the system mode in sales.invoice_payment.mode
--   * masters.card_machine: POS/UPI terminal per branch (TID/MID, provider, settlement bank account, MDR)
--   * sales.invoice_payment.payment_mode_id / card_machine_id (nullable; existing rows and callers unaffected)

ALTER TABLE masters.counter
  ADD COLUMN is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN version   int     NOT NULL DEFAULT 1;
ALTER TABLE masters.box
  ADD COLUMN name      text CONSTRAINT box_name_check CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 100),
  ADD COLUMN is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN version   int     NOT NULL DEFAULT 1;
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON masters.counter FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON masters.box     FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
SELECT platform.enable_audit('masters.counter');
SELECT platform.enable_audit('masters.box');

CREATE TABLE masters.hsn_code (
  tenant_id   uuid NOT NULL REFERENCES platform.tenant(id),
  id          uuid NOT NULL DEFAULT platform.uuid_v7(),
  code_type   text NOT NULL CHECK (code_type IN ('HSN','SAC')),
  code        varchar(8) NOT NULL CHECK (code ~ '^[0-9]{4,8}$'),        -- same format as masters.tax_rule.hsn_sac
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 300),
  uqc         varchar(3) CHECK (uqc ~ '^[A-Z]{3}$'),                    -- GST unit quantity code for GSTR-1 HSN summary (GMS, NOS, ...)
  is_active   boolean NOT NULL DEFAULT true,
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hsn_code_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT hsn_code_uq UNIQUE (tenant_id, code_type, code)
);
COMMENT ON TABLE masters.hsn_code IS 'HSN/SAC catalogue; GST rates are NOT here — masters.tax_rule (hsn_sac) holds them, effective dated';

CREATE TABLE masters.payment_mode (
  tenant_id       uuid NOT NULL REFERENCES platform.tenant(id),
  id              uuid NOT NULL DEFAULT platform.uuid_v7(),
  code            varchar(20) NOT NULL CHECK (code ~ '^[A-Z0-9_]{1,20}$'),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  kind            text NOT NULL CHECK (kind IN ('cash','upi','debit_card','credit_card','bank_transfer','cheque',
                                                'gift_voucher','advance','chit','credit_note','old_gold')),   -- = sales.invoice_payment.mode values (old_gold added in 982)
  account_head_id uuid,                                  -- ledger the tender posts to (cash / bank / clearing)
  requires_reference    boolean NOT NULL DEFAULT false,  -- UTR, cheque no, card approval code
  requires_card_machine boolean NOT NULL DEFAULT false,
  sort_order      int NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_mode_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT payment_mode_code_uq UNIQUE (tenant_id, code),
  CONSTRAINT payment_mode_card_kinds CHECK (NOT requires_card_machine OR kind IN ('debit_card','credit_card','upi')),
  CONSTRAINT payment_mode_head_fk FOREIGN KEY (tenant_id, account_head_id) REFERENCES accounts.account_head(tenant_id, id)
);

CREATE TABLE masters.card_machine (
  tenant_id       uuid NOT NULL REFERENCES platform.tenant(id),
  id              uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id       uuid NOT NULL,
  cash_counter_id uuid,                                  -- till it sits at (accounts.cash_counter)
  code            varchar(20) NOT NULL CHECK (code ~ '^[A-Za-z0-9_-]{1,20}$'),
  provider        text NOT NULL CHECK (char_length(provider) BETWEEN 2 AND 60),    -- bank / PSP (HDFC, Pine Labs, Paytm, ...)
  terminal_id     varchar(20) NOT NULL CHECK (terminal_id ~ '^[A-Za-z0-9]{4,20}$'), -- TID
  merchant_id     varchar(30) CHECK (merchant_id ~ '^[A-Za-z0-9]{4,30}$'),         -- MID
  settlement_bank_account_id uuid,                       -- company masters.bank_account (owner_type checked by the app)
  supports        text[] NOT NULL DEFAULT ARRAY['debit_card','credit_card']::text[]
                  CHECK (cardinality(supports) > 0 AND supports <@ ARRAY['debit_card','credit_card','upi']::text[]),
  mdr_pct         platform.pct CHECK (mdr_pct IS NULL OR (mdr_pct >= 0 AND mdr_pct <= 10)),
  is_active       boolean NOT NULL DEFAULT true,
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_machine_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT card_machine_code_uq UNIQUE (tenant_id, code),
  CONSTRAINT card_machine_tid_uq UNIQUE (tenant_id, provider, terminal_id),
  CONSTRAINT card_machine_branch_fk  FOREIGN KEY (tenant_id, branch_id)       REFERENCES platform.branch(tenant_id, id),
  CONSTRAINT card_machine_counter_fk FOREIGN KEY (tenant_id, cash_counter_id) REFERENCES accounts.cash_counter(tenant_id, id),
  CONSTRAINT card_machine_bank_fk    FOREIGN KEY (tenant_id, settlement_bank_account_id) REFERENCES masters.bank_account(tenant_id, id)
);

ALTER TABLE sales.invoice_payment
  ADD COLUMN payment_mode_id uuid,
  ADD COLUMN card_machine_id uuid,
  ADD CONSTRAINT invoice_payment_mode_fk    FOREIGN KEY (tenant_id, payment_mode_id) REFERENCES masters.payment_mode(tenant_id, id),
  ADD CONSTRAINT invoice_payment_machine_fk FOREIGN KEY (tenant_id, card_machine_id) REFERENCES masters.card_machine(tenant_id, id);

-- ---------- version + audit ----------
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON masters.hsn_code     FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON masters.payment_mode FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON masters.card_machine FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
SELECT platform.enable_audit('masters.hsn_code');
SELECT platform.enable_audit('masters.payment_mode');
SELECT platform.enable_audit('masters.card_machine');

-- ---------- RLS (+ 960's optional branch sub-scope on card_machine, which carries branch_id) ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['masters.hsn_code','masters.payment_mode','masters.card_machine'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = platform.current_tenant()) WITH CHECK (tenant_id = platform.current_tenant())', t);
    EXECUTE format('CREATE POLICY no_partner_access ON %s AS RESTRICTIVE USING (platform.current_partner() IS NULL) WITH CHECK (platform.current_partner() IS NULL)', t);
  END LOOP;
END $$;
CREATE POLICY branch_scope ON masters.card_machine AS RESTRICTIVE
  USING (coalesce(current_setting('app.branch_scope', true), '') = ''
         OR branch_id IS NULL
         OR branch_id::text = ANY (string_to_array(current_setting('app.branch_scope', true), ',')));

-- ---------- grants (masters pattern) ----------
REVOKE ALL ON masters.hsn_code, masters.payment_mode, masters.card_machine FROM PUBLIC, app_rw, app_ro, app_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON masters.hsn_code, masters.payment_mode, masters.card_machine TO app_rw;
GRANT SELECT ON masters.hsn_code, masters.payment_mode, masters.card_machine TO app_ro;
GRANT SELECT ON masters.hsn_code, masters.payment_mode, masters.card_machine
  TO sales_writer, inventory_writer, orders_writer, purchases_writer, refinery_writer;
-- counter / box / invoice_payment: existing table-level grants cover the new columns.
