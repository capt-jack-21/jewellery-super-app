-- READ ONLY audit, ordinary FORCE RLS, tenant by tenant. NEVER run by this task on dev.
-- Supports 990 (projects 992 column defaults) and 998/999. On 990 document_print does not yet exist: its counts
-- are 0. Pin counts include NULL/zero pins; constraints use FALSE (not UNKNOWN), exactly PostgreSQL CHECK semantics.
-- TENANTS (default = ALL, exactly what 999 audits: every platform.tenant row, any status):
--   * no -v slugs  -> every tenant, read from platform.tenant through the all-tenant directory (lookup_read policy
--     of platform_lookup) = the same view 999 has as app_migrator. A role without platform_lookup (app_rw,
--     dev_seed) sees only its own tenant row (tenant_self) and resolve_tenant needs a slug, so it CANNOT list every
--     tenant: the check then STOPS with a clear error, never silently covering fewer tenants than 999.
--     Run default mode as app_migrator (read-only transaction; the role 999 itself runs as).
--   * -v slugs=a,b -> optional filter: only those tenants (resolve_tenant; app_rw/dev_seed OK; unknown slug aborts).
--     Certifies only the listed tenants; 999 re-audits every tenant and fails closed.
--   Superuser / BYPASSRLS sessions are refused (RLS would not scope the counts per tenant).
-- OUTPUT (gates grep the prefixed lines only; psql also echoes per-tenant set_config values):
--   mode|all  or  mode|filter
--   tenants|<n>                       number of tenants covered
--   shop|<slug>|<key>|<count>         52 per tenant (52 x n)
--   count|<key>|<count>               52 (sum over the covered tenants)
--   row|<slug>|<key>|<id>             up to 20 sample ids per tenant and key (UUIDs only)
--   Pass = every count| and shop| value 0, no row| line.
--   52 keys: 19 Sales legacy constraints + 3 print-pin lines (pin_needing_backfill, document_print_template_fk,
--   template_doc_type_mismatch) + 30 non-Sales NOT VALID constraints (977/978 masters, 987/988 inventory).
-- document_print_template_fk: complete pins not resolving to a visible template (id,version) (999 FK).
-- template_doc_type_mismatch: complete pins whose template (id,version) is another document type
--   (payment_receipt must pin a 'receipt' template) (999 3-column FK, NB-1a).
-- The 30 non-Sales predicates are generated from pg_constraint (the exact constraint definitions); a missing
-- constraint stops the check. Every referenced table is SELECT-able by app_rw under tenant RLS.
-- INFORMATIONAL (never pass/fail): active non-platform print templates, all 7 template doc types incl. tag_label:
--   info|tpl|<slug>|<doc_type>|<n>    active tenant-scope templates of the tenant + active partner-scope templates
--                                     of the tenant's own partner (both visible under that tenant's RLS)
--   info|tpl_total|<doc_type>|<n>     distinct templates over the covered tenants (a partner template shared by
--                                     several covered tenants counts once)
--   info|tpl_scope|<text>             limitation: partner templates of a partner with no covered tenant are not
--                                     counted (no partner session is opened; they cannot reach a covered shop's prints)
-- psql -X -q -At -v ON_ERROR_STOP=1 [-v slugs=a,b] -f seeds/check_999_predeploy.sql
\set ON_ERROR_STOP 1
SET default_transaction_read_only=on;
BEGIN READ ONLY;
SELECT set_config('app.partner_id','',true),set_config('app.branch_scope','',true),set_config('app.tenant_id','',true),
       set_config('check999.results','[]',true),set_config('check999.tpl','[]',true) \g /dev/null
SELECT CASE WHEN r.rolsuper OR r.rolbypassrls THEN ('check999: refusing role '||current_user||': superuser/BYPASSRLS ignores RLS, counts would not be per tenant; run as app_migrator (all tenants) or app_rw/dev_seed with -v slugs')::uuid END
 FROM pg_roles r WHERE r.rolname=current_user \g /dev/null
\if :{?slugs}
SELECT 'mode|filter';
SELECT CASE WHEN btrim(:'slugs')='' THEN ('check999: empty -v slugs filter (role '||current_user||'); omit it to cover all tenants')::uuid END \g /dev/null
-- Resolve every slug first; an unknown slug raises a descriptive invalid UUID error.
SELECT CASE WHEN r.tenant_id IS NULL THEN ('unknown tenant slug '||s.slug)::uuid ELSE r.tenant_id END
 FROM (SELECT DISTINCT btrim(x) slug FROM unnest(string_to_array(:'slugs',',')) x WHERE btrim(x)<>'') s
 LEFT JOIN LATERAL platform.resolve_tenant(s.slug) r ON true \g /dev/null
SELECT set_config('check999.tenants',coalesce(jsonb_agg(jsonb_build_object('tenant_id',r.tenant_id,'slug',s.slug,'partner_id',r.partner_id) ORDER BY s.slug),'[]')::text,true)
 FROM (SELECT DISTINCT lower(btrim(x)) slug FROM unnest(string_to_array(:'slugs',',')) x WHERE btrim(x)<>'') s
 CROSS JOIN LATERAL platform.resolve_tenant(s.slug) r \g /dev/null
\else
SELECT 'mode|all';
-- (Error texts concatenate current_user so the cast is not folded at parse time.)
-- Fail loudly when this role cannot see the whole tenant directory (it would silently see only its own row).
SELECT CASE WHEN NOT pg_has_role(current_user,'platform_lookup','USAGE') THEN ('check999: default mode must cover every tenant (999 audits all platform.tenant rows), but role '||current_user||' cannot enumerate every tenant: under forced RLS it sees only its own tenant row and resolve_tenant needs a slug. Run as app_migrator (platform_lookup directory, read-only), or pass -v slugs=... to check only the listed tenants')::uuid END \g /dev/null
SELECT set_config('check999.tenants',coalesce(jsonb_agg(jsonb_build_object('tenant_id',t.id,'slug',t.slug,'partner_id',t.partner_id) ORDER BY t.slug),'[]')::text,true)
 FROM platform.tenant t \g /dev/null
SELECT CASE WHEN jsonb_array_length(current_setting('check999.tenants')::jsonb)=0 THEN ('check999: default mode found 0 tenants as '||current_user||'; refusing to pass an empty audit')::uuid END \g /dev/null
\endif
SELECT 'tenants|'||jsonb_array_length(current_setting('check999.tenants')::jsonb);
-- INF-1: the 30 non-Sales NOT VALID constraints, predicates built from their catalogue definitions (read-only).
SELECT string_agg(format(E'UNION ALL\nSELECT %L key,x.id FROM %s x WHERE %s',key,tbl,pred),E'\n' ORDER BY key) AS nv_union,
       count(*) AS nv_n, array_agg(key ORDER BY key)::text AS nv_keys
FROM (SELECT ns.nspname||'.'||r.relname||'.'||k.conname AS key, format('%I.%I',ns.nspname,r.relname) AS tbl,
        CASE k.contype WHEN 'c' THEN format('(%s) IS FALSE',pg_get_expr(k.conbin,k.conrelid))
        ELSE (SELECT format('(%s) AND NOT EXISTS(SELECT 1 FROM %s y WHERE %s)',
                     string_agg(format('x.%I IS NOT NULL',a.attname),' AND ' ORDER BY u.ord),k.confrelid::regclass,
                     string_agg(format('y.%I=x.%I',b.attname,a.attname),' AND ' ORDER BY u.ord))
                FROM unnest(k.conkey,k.confkey) WITH ORDINALITY u(a,b,ord)
                JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=u.a
                JOIN pg_attribute b ON b.attrelid=k.confrelid AND b.attnum=u.b) END AS pred
      FROM pg_constraint k JOIN pg_class r ON r.oid=k.conrelid JOIN pg_namespace ns ON ns.oid=r.relnamespace
      WHERE k.contype IN ('c','f') AND ns.nspname||'.'||r.relname||'.'||k.conname = ANY(ARRAY[
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
        'inventory.stock_take.stock_take_closed_chk'])) s \gset
SELECT CASE WHEN :nv_n<>30 THEN ('expected the 30 non-Sales constraints, found '||:nv_n)::uuid END \g /dev/null
SELECT format('SELECT set_config(''app.tenant_id'',%L,true);
',r.tenant_id::text) ||
 format($audit$
WITH v AS (
SELECT 'sales.invoice_line.invoice_line_stock_check' key,x.id FROM sales.invoice_line x WHERE ((line_kind='service' AND (to_jsonb(x)->>'stock_kind')::text IS NULL) OR (line_kind='goods' AND (to_jsonb(x)->>'stock_kind')::text IS NOT NULL AND ((to_jsonb(x)->>'stock_kind')::text='tag')=(tag_id IS NOT NULL) AND (to_jsonb(x)->>'purity_id')::uuid IS NOT NULL AND (to_jsonb(x)->>'chargeable_wt')::numeric IS NOT NULL AND (to_jsonb(x)->>'gross_value')::numeric IS NOT NULL)) IS FALSE
UNION ALL
SELECT 'sales.invoice_line.invoice_line_mc_type_check' key,x.id FROM sales.invoice_line x WHERE (mc_type IN ('per_gram','percent','flat','per_piece')) IS FALSE
UNION ALL
SELECT 'sales.invoice_line.invoice_line_weights_check' key,x.id FROM sales.invoice_line x WHERE (net_wt<=gross_wt AND stone_wt<=gross_wt AND ((to_jsonb(x)->>'chargeable_wt')::numeric IS NULL OR (to_jsonb(x)->>'chargeable_wt')::numeric=net_wt+wastage_wt) AND (line_kind='service' OR gross_wt>0) AND (pieces>=1 OR ((to_jsonb(x)->>'stock_kind')::text IS NOT DISTINCT FROM 'loose' AND pieces=0 AND net_wt>0))) IS FALSE
UNION ALL
SELECT 'sales.invoice_line.invoice_line_amounts_check' key,x.id FROM sales.invoice_line x WHERE (metal_value>=0 AND mc_amount>=0 AND stone_amount>=0 AND huid_charge>=0 AND discount>=0 AND coalesce((to_jsonb(x)->>'bill_discount_share')::numeric,0)>=0 AND taxable_value>=0 AND cgst>=0 AND sgst>=0 AND igst>=0 AND coalesce((to_jsonb(x)->>'cess')::numeric,0)>=0 AND rate_per_g>=0) IS FALSE
UNION ALL
SELECT 'sales.invoice_line.invoice_line_taxable_sum_check' key,x.id FROM sales.invoice_line x WHERE (line_kind<>'goods' OR ((to_jsonb(x)->>'gross_value')::numeric=metal_value+mc_amount+stone_amount+huid_charge AND taxable_value=(to_jsonb(x)->>'gross_value')::numeric-discount-coalesce((to_jsonb(x)->>'bill_discount_share')::numeric,0))) IS FALSE
UNION ALL
SELECT 'sales.invoice_line.invoice_line_total_sum_check' key,x.id FROM sales.invoice_line x WHERE (line_total=taxable_value+cgst+sgst+igst+coalesce((to_jsonb(x)->>'cess')::numeric,0)) IS FALSE
UNION ALL
SELECT 'sales.invoice_line.invoice_line_gst_split_check' key,x.id FROM sales.invoice_line x WHERE ((cgst=0 AND sgst=0) OR igst=0) IS FALSE
UNION ALL
SELECT 'sales.invoice_old_metal.invoice_old_metal_required_check' key,x.id FROM sales.invoice_old_metal x WHERE ((to_jsonb(x)->>'valuation_basis')::text IS NOT NULL AND (to_jsonb(x)->>'server_rate_per_g')::numeric IS NOT NULL AND rate_per_g=coalesce((to_jsonb(x)->>'override_rate_per_g')::numeric,(to_jsonb(x)->>'server_rate_per_g')::numeric)) IS FALSE
UNION ALL
SELECT 'sales.invoice_old_metal.invoice_old_metal_weights_check' key,x.id FROM sales.invoice_old_metal x WHERE (net_wt=gross_wt-less_wt AND fine_wt<=net_wt AND touch_pct>0 AND touch_pct<=100) IS FALSE
UNION ALL
SELECT 'sales.invoice_old_metal.invoice_old_metal_amount_check' key,x.id FROM sales.invoice_old_metal x WHERE (rate_per_g>0 AND amount>=0) IS FALSE
UNION ALL
SELECT 'sales.credit_note_line.credit_note_line_total_sum_check' key,x.id FROM sales.credit_note_line x WHERE (line_total=taxable_value+cgst+sgst+igst+coalesce((to_jsonb(x)->>'cess')::numeric,0)) IS FALSE
UNION ALL
SELECT 'sales.invoice.invoice_salesperson_fk',x.id FROM sales.invoice x WHERE x.salesperson_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hr.staff y WHERE y.tenant_id=x.tenant_id AND y.id=x.salesperson_id)
UNION ALL
SELECT 'sales.invoice.invoice_cash_counter_fk',x.id FROM sales.invoice x WHERE x.cash_counter_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounts.cash_counter y WHERE y.tenant_id=x.tenant_id AND y.id=x.cash_counter_id)
UNION ALL
SELECT 'sales.invoice_line.invoice_line_tag_fk',x.id FROM sales.invoice_line x WHERE x.tag_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inventory.tag y WHERE y.tenant_id=x.tenant_id AND y.id=x.tag_id)
UNION ALL
SELECT 'sales.invoice_line.invoice_line_item_fk',x.id FROM sales.invoice_line x WHERE x.item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM masters.item y WHERE y.tenant_id=x.tenant_id AND y.id=x.item_id)
UNION ALL
SELECT 'sales.invoice_line.invoice_line_rate_fk',x.id FROM sales.invoice_line x WHERE x.rate_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rates.metal_rate y WHERE y.tenant_id=x.tenant_id AND y.id=x.rate_id)
UNION ALL
SELECT 'sales.invoice_old_metal.invoice_old_metal_purity_fk',x.id FROM sales.invoice_old_metal x WHERE x.purity_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM masters.purity y WHERE y.tenant_id=x.tenant_id AND y.id=x.purity_id)
UNION ALL
SELECT 'sales.invoice_old_metal.invoice_old_metal_rate_fk',x.id FROM sales.invoice_old_metal x WHERE x.rate_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rates.metal_rate y WHERE y.tenant_id=x.tenant_id AND y.id=x.rate_id)
UNION ALL
SELECT 'sales.estimate.estimate_invoice_fk',x.id FROM sales.estimate x WHERE x.invoice_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sales.invoice y WHERE y.tenant_id=x.tenant_id AND y.id=x.invoice_id)
%1$s
%2$s
), k(key) AS (SELECT unnest(ARRAY['sales.invoice_line.invoice_line_stock_check','sales.invoice_line.invoice_line_mc_type_check','sales.invoice_line.invoice_line_weights_check','sales.invoice_line.invoice_line_amounts_check','sales.invoice_line.invoice_line_taxable_sum_check','sales.invoice_line.invoice_line_total_sum_check','sales.invoice_line.invoice_line_gst_split_check','sales.invoice_old_metal.invoice_old_metal_required_check','sales.invoice_old_metal.invoice_old_metal_weights_check','sales.invoice_old_metal.invoice_old_metal_amount_check','sales.credit_note_line.credit_note_line_total_sum_check','sales.invoice.invoice_salesperson_fk','sales.invoice.invoice_cash_counter_fk','sales.invoice_line.invoice_line_tag_fk','sales.invoice_line.invoice_line_item_fk','sales.invoice_line.invoice_line_rate_fk','sales.invoice_old_metal.invoice_old_metal_purity_fk','sales.invoice_old_metal.invoice_old_metal_rate_fk','sales.estimate.estimate_invoice_fk','sales.document_print.pin_needing_backfill','sales.document_print.document_print_template_fk','sales.document_print.template_doc_type_mismatch']::text[] || %3$L::text[]))
SELECT set_config('check999.results', (current_setting('check999.results')::jsonb ||
 (SELECT jsonb_agg(jsonb_build_array(%4$L,k.key,(SELECT count(*) FROM v WHERE v.key=k.key),
   (SELECT coalesce(jsonb_agg(id),'[]') FROM (SELECT id FROM v WHERE v.key=k.key ORDER BY id LIMIT 20) sample))) FROM k))::text,true);
$audit$,
 CASE WHEN to_regclass('sales.document_print') IS NULL THEN '' ELSE
 $pin$UNION ALL SELECT 'sales.document_print.pin_needing_backfill',id FROM sales.document_print
 WHERE template_id IS NULL OR template_version IS NULL OR template_version<1
 UNION ALL SELECT 'sales.document_print.document_print_template_fk',d.id FROM sales.document_print d
 WHERE d.template_id IS NOT NULL AND d.template_version IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM branding.print_template x WHERE x.id=d.template_id AND x.version=d.template_version)
 UNION ALL SELECT 'sales.document_print.template_doc_type_mismatch',d.id FROM sales.document_print d
  JOIN branding.print_template x ON x.id=d.template_id AND x.version=d.template_version
 WHERE x.doc_type <> CASE d.doc_type WHEN 'payment_receipt' THEN 'receipt' ELSE d.doc_type END$pin$ END,:'nv_union',:'nv_keys',r.slug)
 || format($tpl$
SELECT set_config('check999.tpl', (current_setting('check999.tpl')::jsonb ||
 coalesce((SELECT jsonb_agg(jsonb_build_array(%1$L,x.doc_type,x.id) ORDER BY x.doc_type,x.id) FROM branding.print_template x
  WHERE x.is_active AND ((x.scope='tenant' AND x.tenant_id=%2$L::uuid) OR (x.scope='partner' AND x.partner_id=%3$L::uuid))),'[]'))::text,true);
$tpl$,r.slug,r.tenant_id,r.partner_id)
 FROM jsonb_to_recordset(current_setting('check999.tenants')::jsonb) r(tenant_id uuid,slug text,partner_id uuid) ORDER BY r.slug \gexec
SELECT 'shop|'||(e->>0)||'|'||(e->>1)||'|'||(e->>2)
 FROM jsonb_array_elements(current_setting('check999.results')::jsonb) e ORDER BY e->>0,e->>1;
SELECT 'count|'||(e->>1)||'|'||sum((e->>2)::bigint)
 FROM jsonb_array_elements(current_setting('check999.results')::jsonb) e GROUP BY e->>1 ORDER BY e->>1;
SELECT 'row|'||(e->>0)||'|'||(e->>1)||'|'||id
 FROM jsonb_array_elements(current_setting('check999.results')::jsonb) e CROSS JOIN LATERAL jsonb_array_elements_text(e->3) id;
SELECT 'info|tpl|'||r.slug||'|'||d.doc_type||'|'||(SELECT count(*) FROM jsonb_array_elements(current_setting('check999.tpl')::jsonb) e WHERE e->>0=r.slug AND e->>1=d.doc_type)
 FROM jsonb_to_recordset(current_setting('check999.tenants')::jsonb) r(slug text)
 CROSS JOIN (SELECT unnest(ARRAY['credit_note','estimate','invoice','order_receipt','rate_card','receipt','tag_label']) doc_type
             UNION SELECT e->>1 FROM jsonb_array_elements(current_setting('check999.tpl')::jsonb) e) d ORDER BY r.slug,d.doc_type;
SELECT 'info|tpl_total|'||d.doc_type||'|'||(SELECT count(DISTINCT e->>2) FROM jsonb_array_elements(current_setting('check999.tpl')::jsonb) e WHERE e->>1=d.doc_type)
 FROM (SELECT unnest(ARRAY['credit_note','estimate','invoice','order_receipt','rate_card','receipt','tag_label']) doc_type
       UNION SELECT e->>1 FROM jsonb_array_elements(current_setting('check999.tpl')::jsonb) e) d ORDER BY d.doc_type;
SELECT 'info|tpl_scope|active tenant + own-partner templates visible under each covered tenant''s RLS; partners without a covered tenant not counted; informational only';
ROLLBACK;
