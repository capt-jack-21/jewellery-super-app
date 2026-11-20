-- 999: NB-1 / NB-1a / NB-2 (QA S2/S14/S19/S23) + INF-1. NEW forward migration; 000–998 are immutable.
-- Approved remediation for NULL print pins: effective tenant > partner > platform,
-- then fixed 998 v1 fallback. This is migration-time attribution, NOT evidence of
-- the renderer used historically. Each changed row is NOTICEd and house-audited.
-- Partial IDs are preserved (even inactive); incompatible partial versions abort.
-- Backfill only ever picks a template of the print's own document type (payment_receipt -> receipt).
-- Financial history is NEVER rewritten: invalid legacy checks/FKs abort with
-- tenant/table/constraint/count/sample IDs; remediation needs separate approval.
-- Owner app_migrator (not superuser/BYPASSRLS): inherited platform_lookup exposes
-- the tenant directory, then all DML/audits run tenant-by-tenant with FORCE RLS ON.
-- VALIDATE requires ownership and scans the whole table independently of RLS.
-- Pins must reference a real template version OF THE SAME DOCUMENT TYPE (NB-1a):
--   * document_print.template_doc_type: STORED generated column mapping the print's doc_type onto the
--     print_template domain (payment_receipt -> receipt; invoice/estimate/credit_note unchanged). No trigger/function.
--   * UNIQUE(id,version,doc_type) on branding.print_template (each version is its own row, so old versions stay
--     referenceable) + composite FK document_print(template_id,template_version,template_doc_type) ->
--     print_template(id,version,doc_type) ON DELETE/UPDATE RESTRICT (prints are immutable history).
--   * It supersedes the earlier draft's 2-column UNIQUE(id,version) + FK (implied by the 3-column pair), which are
--     not created; a DB that ran that draft (never deployed) converges here.
--   FK checks bypass RLS, so tenant writers can pin visible partner/platform templates; scope remains
--   API/RLS-enforced. Legacy pins not resolving to a visible (id,version), or resolving to another document
--   type, abort with diagnostics before any DDL.
-- INF-1: the 30 NOT VALID constraints outside Sales (977/978 masters, 987/988 inventory) are audited per tenant
-- exactly like the 19 Sales ones and VALIDATEd (SHARE UPDATE EXCLUSIVE; FK: + ROW SHARE on the referenced table).
-- No policies, grants, roles, persistent functions or triggers are added/disabled.
-- One atomic DO: failure rolls back backfill + all DDL even under psql autocommit.
DO $$
DECLARE
  t record; p record; c record; chosen record; n bigint; ids uuid[];
  bad text := ''; changed bigint := 0; expr text; predicate text;
  old_t text := current_setting('app.tenant_id',true);
  old_p text := current_setting('app.partner_id',true);
  old_b text := current_setting('app.branch_scope',true);
  old_u text := current_setting('app.user_id',true);
  old_l text := current_setting('lock_timeout');
  old_s text := current_setting('statement_timeout');
  -- Exactly the 19 legacy Sales constraints from 992 (997 replaces weights_check).
  s19 text[] := ARRAY[
    'sales.invoice.invoice_salesperson_fk','sales.invoice.invoice_cash_counter_fk',
    'sales.invoice_line.invoice_line_tag_fk','sales.invoice_line.invoice_line_item_fk','sales.invoice_line.invoice_line_rate_fk',
    'sales.invoice_line.invoice_line_stock_check','sales.invoice_line.invoice_line_mc_type_check','sales.invoice_line.invoice_line_weights_check',
    'sales.invoice_line.invoice_line_amounts_check','sales.invoice_line.invoice_line_taxable_sum_check','sales.invoice_line.invoice_line_total_sum_check',
    'sales.invoice_line.invoice_line_gst_split_check','sales.invoice_old_metal.invoice_old_metal_purity_fk','sales.invoice_old_metal.invoice_old_metal_rate_fk',
    'sales.invoice_old_metal.invoice_old_metal_required_check','sales.invoice_old_metal.invoice_old_metal_weights_check',
    'sales.invoice_old_metal.invoice_old_metal_amount_check','sales.credit_note_line.credit_note_line_total_sum_check','sales.estimate.estimate_invoice_fk'];
  -- Exactly the 30 NOT VALID constraints outside Sales (catalogue of a fresh head DB = files 977, 978, 987, 988).
  nv30 text[] := ARRAY[
    'masters.stone_standard.stone_standard_cent_band',
    'masters.diamond_rate.diamond_rate_period','masters.diamond_rate.diamond_rate_rates_nonneg','masters.diamond_rate.diamond_rate_has_key',
    'masters.diamond_rate.diamond_rate_stone_fk','masters.diamond_rate.diamond_rate_shape_fk','masters.diamond_rate.diamond_rate_clarity_fk',
    'masters.diamond_rate.diamond_rate_colour_fk','masters.diamond_rate.diamond_rate_cut_fk','masters.diamond_rate.diamond_rate_vendor_fk',
    'masters.value_addition_rule.var_metal_fk','masters.value_addition_rule.var_sub_item_fk','masters.value_addition_rule.var_one_mc_basis',
    'masters.value_addition_rule.var_one_wastage_basis','masters.value_addition_rule.var_nonneg','masters.value_addition_rule.var_weight_band',
    'inventory.tag.tag_pieces_check','inventory.tag.tag_stone_le_gross','inventory.lot_line.lot_line_tagged_check',
    'inventory.stock_transfer.stock_transfer_dispatched_chk','inventory.stock_transfer.stock_transfer_received_chk',
    'inventory.stock_transfer.stock_transfer_approved_chk','inventory.stock_transfer.stock_transfer_cancelled_chk',
    'inventory.stock_transfer.stock_transfer_received_after_dispatch','inventory.stock_transfer.stock_transfer_requested_by_fk',
    'inventory.stock_transfer.stock_transfer_approved_by_fk','inventory.stock_transfer.stock_transfer_received_by_fk',
    'inventory.stock_transfer_line.stock_transfer_line_received_chk','inventory.stock_transfer_line.stock_transfer_line_what',
    'inventory.stock_take.stock_take_closed_chk'];
BEGIN
  IF current_user <> 'app_migrator' OR NOT pg_has_role(current_user,'platform_lookup','USAGE') THEN
    RAISE EXCEPTION '999: run as owner app_migrator with inherited platform_lookup (all-tenant directory); nothing changed';
  END IF;
  SELECT count(*) INTO n FROM pg_constraint k JOIN pg_class r ON r.oid=k.conrelid JOIN pg_namespace ns ON ns.oid=r.relnamespace
   WHERE ns.nspname||'.'||r.relname||'.'||k.conname = ANY(s19||nv30);
  IF n<>49 THEN
    RAISE EXCEPTION '999: expected the 19 Sales + 30 non-Sales legacy constraints, found %; nothing changed',n;
  END IF;
  PERFORM set_config('lock_timeout','5s',true);
  PERFORM set_config('statement_timeout','10min',true);
  -- Prevent concurrent tenant/print/template/legacy writes between audit and DDL.
  -- The 30 non-Sales tables are not pre-locked: their NOT VALID constraints already reject new violating
  -- writes, so audit and VALIDATE (SHARE UPDATE EXCLUSIVE, reads + writes continue) cannot diverge.
  LOCK TABLE platform.tenant IN SHARE MODE;
  LOCK TABLE branding.print_template IN ACCESS EXCLUSIVE MODE; -- ADD UNIQUE needs it; avoid a later lock upgrade
  LOCK TABLE sales.document_print IN ACCESS EXCLUSIVE MODE;    -- generated column rewrite + FK
  LOCK TABLE sales.invoice, sales.invoice_line, sales.invoice_old_metal,
             sales.credit_note_line, sales.estimate IN SHARE ROW EXCLUSIVE MODE;
  PERFORM set_config('app.partner_id','',true);
  PERFORM set_config('app.branch_scope','',true);
  PERFORM set_config('app.user_id','',true); -- migration audit actor is NULL, not an impersonated shop user
  FOR t IN SELECT id,slug,partner_id FROM platform.tenant ORDER BY id LOOP
    PERFORM set_config('app.tenant_id',t.id::text,true);
    FOR p IN SELECT * FROM sales.document_print WHERE template_id IS NULL OR template_version IS NULL ORDER BY id LOOP
      SELECT x.id,x.version INTO chosen FROM branding.print_template x
       WHERE x.doc_type=CASE p.doc_type WHEN 'payment_receipt' THEN 'receipt' ELSE p.doc_type END
         AND ((x.scope='tenant' AND x.tenant_id=t.id) OR (x.scope='partner' AND x.partner_id=t.partner_id) OR x.scope='platform')
         AND CASE WHEN p.template_id IS NOT NULL THEN x.id=p.template_id
                  ELSE x.is_active OR (x.scope='platform' AND x.version=1 AND x.id=CASE p.doc_type
                     WHEN 'invoice' THEN '01a1c455-29fa-769b-84f9-377a9bcdab46'::uuid
                     WHEN 'estimate' THEN '01a1c455-29fa-7963-88e9-d3cf6e2a8240'::uuid
                     WHEN 'credit_note' THEN '01a1c455-29fa-7856-b4ed-a3710fd91ec1'::uuid
                     WHEN 'payment_receipt' THEN '01a1c455-29fa-7811-b4b1-95efbd5b9ea5'::uuid END) END
       ORDER BY CASE WHEN x.is_active THEN 0 ELSE 1 END,
                CASE x.scope WHEN 'tenant' THEN 0 WHEN 'partner' THEN 1 ELSE 2 END, x.id LIMIT 1;
      IF NOT FOUND OR chosen.version < 1 OR (p.template_version IS NOT NULL AND p.template_version <> chosen.version) THEN
        RAISE EXCEPTION '999: cannot backfill print pin tenant=% row=% type=% old=(%,%); nothing changed',t.slug,p.id,p.doc_type,p.template_id,p.template_version
          USING HINT='Needs an applicable exact template of the same document type (payment_receipt -> receipt). Restore it or approve explicit legacy remediation; never invent a template/version.';
      END IF;
      UPDATE sales.document_print SET template_id=chosen.id,template_version=chosen.version WHERE tenant_id=t.id AND id=p.id;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n<>1 THEN RAISE EXCEPTION '999: RLS backfill missed tenant=% print=%; nothing changed',t.slug,p.id; END IF;
      RAISE NOTICE '999: backfilled tenant=% print=% old=(%,%) new=(%,%)',t.slug,p.id,p.template_id,p.template_version,chosen.id,chosen.version;
      changed := changed+1;
    END LOOP;
    SELECT count(*), (array_agg(id ORDER BY id))[1:20] INTO n,ids FROM sales.document_print
     WHERE template_id IS NULL OR template_version IS NULL OR template_version<1;
    IF n>0 THEN bad := bad || format(' tenant=%s sales.document_print.pin=%s ids=%s;',t.slug,n,ids); END IF;
    -- Complete pins must resolve to a template version visible to this tenant (tenant/own partner/platform).
    SELECT count(*), (array_agg(d.id ORDER BY d.id))[1:20] INTO n,ids FROM sales.document_print d
     WHERE d.template_id IS NOT NULL AND d.template_version IS NOT NULL
       AND NOT EXISTS(SELECT 1 FROM branding.print_template x WHERE x.id=d.template_id AND x.version=d.template_version);
    IF n>0 THEN bad := bad || format(' tenant=%s sales.document_print.document_print_template_fk=%s ids=%s;',t.slug,n,ids); END IF;
    -- ...and that version must be a template of the print's own document type (NB-1a).
    SELECT count(*), (array_agg(d.id ORDER BY d.id))[1:20] INTO n,ids FROM sales.document_print d
      JOIN branding.print_template x ON x.id=d.template_id AND x.version=d.template_version
     WHERE x.doc_type <> CASE d.doc_type WHEN 'payment_receipt' THEN 'receipt' ELSE d.doc_type END;
    IF n>0 THEN bad := bad || format(' tenant=%s sales.document_print.template_doc_type_mismatch=%s ids=%s;',t.slug,n,ids); END IF;
    -- The 19 Sales + 30 non-Sales legacy constraints, using their exact catalogue definitions.
    FOR c IN SELECT k.*,format('%I.%I',ns.nspname,r.relname) AS tbl FROM pg_constraint k
        JOIN pg_class r ON r.oid=k.conrelid JOIN pg_namespace ns ON ns.oid=r.relnamespace
       WHERE ns.nspname||'.'||r.relname||'.'||k.conname = ANY(s19||nv30)
       ORDER BY ns.nspname,r.relname,k.conname LOOP
      IF c.contype='c' THEN
        expr := pg_get_expr(c.conbin,c.conrelid);
        predicate := format('(%s) IS FALSE',expr); -- CHECK allows UNKNOWN, not FALSE
      ELSE
        SELECT string_agg(format('x.%I IS NOT NULL',a.attname),' AND ' ORDER BY u.ord),
               string_agg(format('y.%I=x.%I',b.attname,a.attname),' AND ' ORDER BY u.ord)
          INTO expr,predicate FROM unnest(c.conkey,c.confkey) WITH ORDINALITY u(a,b,ord)
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=u.a
          JOIN pg_attribute b ON b.attrelid=c.confrelid AND b.attnum=u.b;
        predicate := format('(%s) AND NOT EXISTS(SELECT 1 FROM %s y WHERE %s)',expr,c.confrelid::regclass,predicate); -- MATCH SIMPLE
      END IF;
      EXECUTE format('SELECT count(*),(array_agg(id ORDER BY id))[1:20] FROM %s x WHERE %s',c.tbl,predicate) INTO n,ids;
      IF n>0 THEN bad := bad || format(' tenant=%s %s.%s=%s ids=%s;',t.slug,c.tbl,c.conname,n,ids); END IF;
    END LOOP;
  END LOOP;
  IF bad<>'' THEN
    RAISE EXCEPTION '999: legacy violations:% nothing changed',bad
      USING HINT='Run check_999_predeploy.sql for every tenant; do not modify financial/stock/master history without an approved remediation.';
  END IF;
  ALTER TABLE sales.document_print ALTER COLUMN template_id SET NOT NULL, ALTER COLUMN template_version SET NOT NULL,
    ADD COLUMN IF NOT EXISTS template_doc_type text
      GENERATED ALWAYS AS (CASE doc_type WHEN 'payment_receipt' THEN 'receipt' ELSE doc_type END) STORED;
  COMMENT ON COLUMN sales.document_print.template_doc_type IS 'Generated (999): print doc_type in the branding.print_template domain (payment_receipt -> receipt). Third column of document_print_template_fk; never written by the app.';
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='sales.document_print'::regclass AND conname='document_print_template_version_check') THEN
    ALTER TABLE sales.document_print ADD CONSTRAINT document_print_template_version_check CHECK(template_version>=1);
  END IF;
  -- Converge a DB that ran the superseded (id, version) draft of 999 (never deployed).
  IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='sales.document_print'::regclass AND conname='document_print_template_fk' AND cardinality(conkey)<>3) THEN
    ALTER TABLE sales.document_print DROP CONSTRAINT document_print_template_fk;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='branding.print_template'::regclass AND conname='print_template_id_version_uq') THEN
    ALTER TABLE branding.print_template DROP CONSTRAINT print_template_id_version_uq;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='branding.print_template'::regclass AND conname='print_template_id_version_doc_type_uq') THEN
    ALTER TABLE branding.print_template ADD CONSTRAINT print_template_id_version_doc_type_uq UNIQUE (id, version, doc_type);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='sales.document_print'::regclass AND conname='document_print_template_fk') THEN
    ALTER TABLE sales.document_print ADD CONSTRAINT document_print_template_fk FOREIGN KEY (template_id, template_version, template_doc_type)
      REFERENCES branding.print_template(id, version, doc_type) ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
  CREATE INDEX IF NOT EXISTS document_print_template_idx ON sales.document_print (template_id, template_version);
  FOR c IN SELECT format('%I.%I',ns.nspname,r.relname) AS tbl, k.conname FROM pg_constraint k
      JOIN pg_class r ON r.oid=k.conrelid JOIN pg_namespace ns ON ns.oid=r.relnamespace
     WHERE ns.nspname||'.'||r.relname||'.'||k.conname = ANY(s19||nv30) AND NOT k.convalidated
     ORDER BY ns.nspname,r.relname,k.conname LOOP
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I',c.tbl,c.conname);
  END LOOP;
  PERFORM set_config('app.tenant_id',coalesce(old_t,''),true);
  PERFORM set_config('app.partner_id',coalesce(old_p,''),true);
  PERFORM set_config('app.branch_scope',coalesce(old_b,''),true);
  PERFORM set_config('app.user_id',coalesce(old_u,''),true);
  PERFORM set_config('lock_timeout',old_l,true);
  PERFORM set_config('statement_timeout',old_s,true);
  RAISE NOTICE '999: % print rows backfilled; pin NOT NULL/positive/FK to template (id, version, doc type); 19 Sales + 30 non-Sales legacy constraints validated',changed;
END $$;
