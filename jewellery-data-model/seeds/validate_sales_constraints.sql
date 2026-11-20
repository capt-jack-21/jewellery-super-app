-- seeds/validate_sales_constraints.sql — VALIDATE exactly two NOT VALID Sales constraints from 992, after the 991–998 migrate:
--   sales.invoice_line      invoice_line_stock_check
--   sales.invoice_old_metal invoice_old_metal_required_check
-- Both fail by construction on every pre-992 goods line / old-gold line (their columns arrive NULL with no backfill), so this is
-- only safe on a DB with NO pre-992 bills with goods lines or old gold (dev demo shops: 0 such rows, pre-check 9 Nov 19:53 IST).
-- Any DB that has such rows needs an approved backfill first; this file never backfills and then aborts.
-- 997 replaces invoice_line_weights_check (one of those 17), retaining NOT VALID; this seed does not validate it.
-- The other 17 NOT VALID Sales constraints stay NOT VALID until separately approved: this file never touches them.
-- NOT a migration (lead decision 9 Nov 2026 19:56 IST): Wheeljack runs it once, after migrate, during the Sales deploy.
--
-- Run as the Postgres SUPERUSER login (counts must see every tenant: forced RLS hides rows from app_migrator); the two
-- ALTER TABLE … VALIDATE CONSTRAINT run under SET LOCAL SESSION AUTHORIZATION app_migrator (owner; the schema-change guard only
-- lets session_user app_migrator alter module schemas, and logs it to public.schema_change_log). On the server, e.g.:
--   docker compose -f /opt/jewellery/docker-compose.yml --env-file /opt/jewellery/.env exec -T postgres \
--     psql -X -q -v ON_ERROR_STOP=1 -U "$SU" -d "$DB" -f - < seeds/validate_sales_constraints.sql
-- One transaction. It aborts (ROLLBACK, nothing validated) unless: the session is a superuser; 991–998 are applied (schema markers,
-- and migrator.schema_migrations rows when that table exists); both constraints exist; and 0 rows violate either one.
-- VALIDATE takes SHARE UPDATE EXCLUSIVE (reads / writes continue); lock_timeout 5s. Re-running after success is a no-op.
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';
DO $$
DECLARE c record; n bigint; missing text; bad text := '';
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'validate_sales_constraints: run as the Postgres superuser (counts must see every tenant through forced RLS); nothing validated';
  END IF;
  -- 991–998 applied?
  SELECT string_agg(m, ', ') INTO missing FROM (VALUES
      ('991 sales.shop_setting',                     to_regclass('sales.shop_setting') IS NOT NULL),
      ('992 sales.invoice_line.stock_kind',          EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'sales.invoice_line'::regclass AND attname = 'stock_kind' AND NOT attisdropped)),
      ('993 sales.payment_receipt.reverses_receipt_id', to_regclass('sales.payment_receipt') IS NOT NULL
                                                     AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('sales.payment_receipt') AND attname = 'reverses_receipt_id' AND NOT attisdropped)),
      ('994 issued_doc_guard counts receipt tenders', pg_get_functiondef('sales.issued_doc_guard'::regproc) LIKE '%payment_receipt_tender%'),
      ('995 sales.credit_note.reversal_receipt_id',  EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'sales.credit_note'::regclass AND attname = 'reversal_receipt_id' AND NOT attisdropped)),
      ('996 reports.gstr1_doc_summary.excluded_receipt_reversal_count', EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'reports.gstr1_doc_summary'::regclass AND attname = 'excluded_receipt_reversal_count' AND NOT attisdropped)),
      ('997 sales.document_print.doc_cancelled', EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('sales.document_print') AND attname = 'doc_cancelled' AND NOT attisdropped)),
      ('998 platform print defaults', (SELECT count(*)=4 FROM branding.print_template WHERE scope='platform' AND partner_id IS NULL AND tenant_id IS NULL AND version=1 AND is_active
          AND id IN ('01a1c455-29fa-769b-84f9-377a9bcdab46','01a1c455-29fa-7963-88e9-d3cf6e2a8240','01a1c455-29fa-7856-b4ed-a3710fd91ec1','01a1c455-29fa-7811-b4b1-95efbd5b9ea5')))
    ) v(m, ok) WHERE NOT ok;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'validate_sales_constraints: 991–998 not applied (missing: %); nothing validated', missing;
  END IF;
  IF to_regclass('migrator.schema_migrations') IS NOT NULL THEN
    SELECT string_agg(f, ', ') INTO missing FROM unnest(ARRAY['991_sales_settings_permissions.sql','992_sales_documents.sql',
             '993_sales_receipts_print.sql','994_sales_store_credit_receipts.sql','995_sales_reversal_store_credit.sql','996_sales_gstr1_exclude_receipt_reversal.sql','997_sales_print_cancelled_and_loose_weight.sql','998_print_template_platform_defaults.sql']) f
     WHERE NOT EXISTS (SELECT 1 FROM migrator.schema_migrations s WHERE s.filename = f);
    IF missing IS NOT NULL THEN
      RAISE EXCEPTION 'validate_sales_constraints: not recorded in migrator.schema_migrations: %; nothing validated', missing;
    END IF;
  END IF;
  -- count first: rows where the constraint expression is FALSE (CHECK semantics), all tenants (superuser bypasses RLS)
  FOR c IN SELECT x.tbl, x.con, k.oid, k.conrelid, k.convalidated
             FROM (VALUES ('sales.invoice_line','invoice_line_stock_check'), ('sales.invoice_old_metal','invoice_old_metal_required_check')) x(tbl, con)
             LEFT JOIN pg_constraint k ON k.conrelid = x.tbl::regclass AND k.conname = x.con AND k.contype = 'c' LOOP
    IF c.oid IS NULL THEN
      RAISE EXCEPTION 'validate_sales_constraints: constraint %.% not found; nothing validated', c.tbl, c.con;
    END IF;
    EXECUTE format('SELECT count(*) FROM %s WHERE (%s) IS FALSE', c.conrelid::regclass, pg_get_expr((SELECT conbin FROM pg_constraint WHERE oid = c.oid), c.conrelid))
      INTO n;
    RAISE NOTICE 'validate_sales_constraints: %.% violating rows = % (validated already: %)', c.tbl, c.con, n, c.convalidated;
    IF n > 0 THEN bad := bad || format(' %s.%s=%s', c.tbl, c.con, n); END IF;
  END LOOP;
  IF bad <> '' THEN
    RAISE EXCEPTION 'validate_sales_constraints: violating rows:% — pre-992 bills need an approved backfill first; nothing validated', bad;
  END IF;
END $$;
SET LOCAL SESSION AUTHORIZATION app_migrator;
ALTER TABLE sales.invoice_line      VALIDATE CONSTRAINT invoice_line_stock_check;
ALTER TABLE sales.invoice_old_metal VALIDATE CONSTRAINT invoice_old_metal_required_check;
RESET SESSION AUTHORIZATION;
SELECT 'validated|' || conrelid::regclass || '|' || conname || '|' || convalidated FROM pg_constraint
 WHERE conname IN ('invoice_line_stock_check','invoice_old_metal_required_check') AND connamespace = 'sales'::regnamespace ORDER BY conname;
SELECT 'still_not_valid|' || count(*) FROM pg_constraint WHERE NOT convalidated AND connamespace = 'sales'::regnamespace;
COMMIT;
