#!/usr/bin/env bash
set -uo pipefail

LOG=tests/last_run.log
main() {
cd "$(dirname "$0")/.."
migration_files() {  # numeric-prefix order (010..999, then 01000...); text-order globs would put 01000 before 010
  ls migrations/*.sql | grep -v '/000_bootstrap\.sql$' | awk -F/ '{n=$NF; sub(/_.*/,"",n); printf "%d\t%s\n", n+0, $0}' | sort -t"$(printf '\t')" -k1,1n -k2,2 | cut -f2
}
DB=${DM_TEST_DB:-${1:-jewellery_test}}
if [ -n "${DM_TEST_DB:-}" ] && [[ ! "$DB" =~ ^dm999_(fresh|upgrade)_[0-9]{14}$ ]]; then
  echo 'FAIL  unsafe DM_TEST_DB name'; return 1
fi
MODE=${MODE:-fresh}     # fresh = all migrations from zero; upgrade = dev's applied set first, then the new files
echo "--- mode: $MODE"
# immutability guard: applied migrations must be byte-identical to what dev recorded in schema_migrations
if (cd migrations && sha256sum --quiet -c APPLIED.sha256); then echo "PASS  applied migrations unchanged ($(wc -l < migrations/APPLIED.sha256) files match APPLIED.sha256)"
else echo "FAIL  an applied migration was edited (see sha256sum -c migrations/APPLIED.sha256)"; fi
export PGPASSWORD=dev
# check_999_predeploy gate: exactly one tenants|<n>, 52 count| lines, 52*n shop| lines, every value 0, no row| line
p999_gate() {
  local out="$1" n="$2"
  [ "$(echo "$out" | grep '^tenants|')" = "tenants|$n" ] && [ "$(echo "$out" | grep -c '^count|')" = 52 ] \
    && [ "$(echo "$out" | grep -c '^shop|')" = $((52 * n)) ] && ! grep -q '^row|' <<<"$out" \
    && ! echo "$out" | grep -E '^(count|shop)\|' | awk -F'|' '$NF!=0 {bad=1} END {exit !bad}'
}
# superuser ground truth: tenant count / slugs, and the info|tpl / info|tpl_total lines the pre-check must print
p999_su() { sudo -u postgres psql -d "$DB" -X -At -v ON_ERROR_STOP=1 -c "$1"; }
P999_TYPES="ARRAY['credit_note','estimate','invoice','order_receipt','rate_card','receipt','tag_label']"
P999_TPL_SQL="SELECT 'info|tpl|'||t.slug||'|'||d||'|'||(SELECT count(*) FROM branding.print_template x WHERE x.is_active AND x.doc_type=d
  AND ((x.scope='tenant' AND x.tenant_id=t.id) OR (x.scope='partner' AND x.partner_id=t.partner_id)))
  FROM platform.tenant t CROSS JOIN unnest($P999_TYPES) d ORDER BY t.slug, d"
P999_TOT_SQL="SELECT 'info|tpl_total|'||d||'|'||(SELECT count(DISTINCT x.id) FROM branding.print_template x JOIN platform.tenant t
  ON (x.scope='tenant' AND x.tenant_id=t.id) OR (x.scope='partner' AND x.partner_id=t.partner_id) WHERE x.is_active AND x.doc_type=d)
  FROM unnest($P999_TYPES) d ORDER BY d"
# P999 fixture (one owner transaction, discarded by the pre-check's own ROLLBACK): partner p999-partner with two tenants that are in
# no slug list (p999-unlisted-a / -b); tenant + partner, active + inactive templates across doc types incl. tag_label; and a masters
# CHECK + FK violation in p999-unlisted-a only.
p999_fixture() { cat <<'SQL'
SET app.user_id = '';
SET app.branch_scope = '';
SET app.tenant_id = '';
BEGIN;
SET LOCAL app.partner_id = '00000000-0000-4000-8000-0000000ea999';
INSERT INTO platform.partner(id, slug, legal_name) VALUES ('00000000-0000-4000-8000-0000000ea999','p999-partner','P999 Partner LLP');
INSERT INTO platform.tenant(id, partner_id, slug, display_name) VALUES
 ('00000000-0000-4000-8000-0000000ea99a','00000000-0000-4000-8000-0000000ea999','p999-unlisted-a','P999 Unlisted A'),
 ('00000000-0000-4000-8000-0000000ea99b','00000000-0000-4000-8000-0000000ea999','p999-unlisted-b','P999 Unlisted B');
INSERT INTO branding.print_template(scope, partner_id, doc_type, version, body_key, is_active) VALUES
 ('partner','00000000-0000-4000-8000-0000000ea999','tag_label',1,'tpl/p999/tag-v1.hbs',true),
 ('partner','00000000-0000-4000-8000-0000000ea999','receipt',1,'tpl/p999/receipt-v1.hbs',true),
 ('partner','00000000-0000-4000-8000-0000000ea999','invoice',1,'tpl/p999/invoice-v1.hbs',false),
 ('partner','00000000-0000-4000-8000-0000000ea999','rate_card',1,'tpl/p999/rate-v1.hbs',false);
SET LOCAL app.partner_id = '';
SET LOCAL app.tenant_id = '00000000-0000-4000-8000-0000000ea99a';
INSERT INTO branding.print_template(scope, tenant_id, doc_type, version, body_key, is_active) VALUES
 ('tenant','00000000-0000-4000-8000-0000000ea99a','invoice',1,'tpl/p999a/invoice-v1.hbs',true),
 ('tenant','00000000-0000-4000-8000-0000000ea99a','invoice',2,'tpl/p999a/invoice-v2.hbs',false),
 ('tenant','00000000-0000-4000-8000-0000000ea99a','tag_label',1,'tpl/p999a/tag-v1.hbs',true),
 ('tenant','00000000-0000-4000-8000-0000000ea99a','estimate',1,'tpl/p999a/estimate-v1.hbs',false);
SELECT pg_get_constraintdef(oid) || ' NOT VALID' AS vwb_def FROM pg_constraint WHERE conrelid = 'masters.value_addition_rule'::regclass AND conname = 'var_weight_band' \gset
SELECT pg_get_constraintdef(oid) || ' NOT VALID' AS vmf_def FROM pg_constraint WHERE conrelid = 'masters.value_addition_rule'::regclass AND conname = 'var_metal_fk' \gset
ALTER TABLE masters.value_addition_rule DROP CONSTRAINT var_weight_band, DROP CONSTRAINT var_metal_fk;
INSERT INTO masters.value_addition_rule(tenant_id, id, scope, metal_id, weight_from, weight_to)
VALUES ('00000000-0000-4000-8000-0000000ea99a', '00000000-0000-4000-8000-0000000ea99c', 'customer', '00000000-0000-0000-0000-00000000dead', 5, 1);
ALTER TABLE masters.value_addition_rule ADD CONSTRAINT var_weight_band :vwb_def, ADD CONSTRAINT var_metal_fk :vmf_def;
SET LOCAL app.tenant_id = '';
SQL
}
if [ "$MODE" = upgrade ]; then
  APPLY_SET=applied ./apply.sh "$DB" > /tmp/apply.log 2>&1 || { cat /tmp/apply.log; exit 1; }
  grep -E "applying|ALL MIGRATIONS" /tmp/apply.log
  # smoke checks of the old (dev) state before upgrading — the full suite targets the new state
  old=$(psql -h localhost -U app_migrator -d "$DB" -At -c "SELECT (to_regclass('platform.rate_limit_bucket') IS NULL)::text
        || (to_regclass('masters.bank_account') IS NULL)::text
        || (SELECT count(*) FROM pg_proc WHERE proname = 'provision_tenant' AND pronargs = 14)::text
        || (SELECT count(*) FROM information_schema.columns WHERE table_schema='platform' AND table_name='company' AND column_name='bank_accounts')::text")
  pending=$(cd migrations && ls [0-9]*.sql | grep -vxF -f <(awk '{print $2}' APPLIED.sha256 | sed 's/^\*//') | wc -l)
  if [ "$pending" -eq 0 ]; then
    # every migration is applied on dev (000–970 since 2026-10-24): the "old" state IS the head state
    head_ok=$(psql -h localhost -U app_migrator -d "$DB" -At -c "SELECT (to_regclass('platform.file') IS NOT NULL
        AND to_regprocedure('platform.referenced_object_keys(text[])') IS NULL)::text")
    if [ "$old" = "falsefalse00" ] && [ "$head_ok" = true ]; then echo "PASS  upgrade: no pending migrations; DB is at the dev applied state 000–974 (= head; parked 975 absent)"
    else echo "FAIL  upgrade: unexpected pre-upgrade state ($old)"; fi
  elif [ "$old" = "falsefalse00" ] && [ "$(psql -h localhost -U app_migrator -d "$DB" -At -c "SELECT (SELECT count(*) FROM pg_proc WHERE proname = 'provision_tenant' AND pronargs = 16)::text
        || (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'masters' AND table_name = 'metal' AND column_name = 'version')::text
        || (to_regclass('platform.file') IS NOT NULL)::text
        || (to_regprocedure('platform.referenced_object_keys(text[])') IS NULL)::text")" = 11truetrue ]; then
    echo "PASS  upgrade: DB is at the dev applied state (000–974: platform.file present; parked 975 absent) before $pending new file(s)"
  else echo "FAIL  upgrade: unexpected pre-upgrade state ($old)"; fi
  # 972: masters.metal/purity ACLs before the upgrade, and seed now so metal/purity rows exist before 972 adds columns
  acl_sql="SELECT string_agg(c.relname || '=' || coalesce(c.relacl::text, '-'), ';' ORDER BY c.relname) FROM pg_class c
           WHERE c.oid IN ('masters.metal'::regclass, 'masters.purity'::regclass)"
  acl_pre=$(psql -h localhost -U app_migrator -d "$DB" -At -c "$acl_sql")
  psql -h localhost -U app_migrator -d "$DB" -q -f tests/seed.sql; SEEDED=1
  # PD1–PD3: pre-deploy NOT VALID check at the 000–986 state. Skipped once 987–989 are on APPLIED (dev past 986).
  if grep -q ' 987_inventory_settings_tags.sql$' migrations/APPLIED.sha256; then
    echo "PASS  PD1–PD3 skipped: 987–989 are on APPLIED (dev baseline past 986); use seeds/check_inventory_not_valid.sql on head"
  else
  # PD: pre-deploy NOT VALID check (seeds/check_inventory_not_valid_predeploy.sql) at the dev 000–986 state, before 987–989
  pd_run() { psql -h localhost -U app_rw -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -v slugs=sri-lakshmi,other-shop -f seeds/check_inventory_not_valid_predeploy.sql 2>&1; }
  pd_counts() { echo "$1" | grep '^count|' | cut -d'|' -f2,3; }
  pd0=$(pd_run); pd0_rc=$?
  if [ $pd0_rc -eq 0 ] && [ "$(echo "$pd0" | grep -c '^col|')" = 19 ] && ! echo "$pd0" | grep '^col|' | awk -F'|' '$4 != $6' | grep -q . \
     && [ "$(echo "$pd0" | grep -c '^count|')" = 14 ]; then
    echo "PASS  PD1 pre-deploy check at 986: 19 referenced columns as expected (3 added by 988 absent), 14 constraint counts"
  else echo "FAIL  PD1 pre-deploy check at 986: $pd0"; LOG_FAIL=1; fi
  pdi=$(psql -h localhost -U app_migrator -d "$DB" -X -q -v ON_ERROR_STOP=1 2>&1 <<'SQL'
SET app.tenant_id = '00000000-0000-0000-0000-000000000001';
BEGIN;
INSERT INTO platform.branch(tenant_id, id, company_id, code, name, bill_series_prefix, state_code) VALUES
 (current_setting('app.tenant_id')::uuid, '00000000-0000-0000-0000-00000000bd01', '00000000-0000-0000-0000-00000000c001', 'PDX', 'Predeploy test', 'PDX', '33');
INSERT INTO inventory.stock_transfer(tenant_id, id, transfer_no, from_branch_id, to_branch_id, status, requested_by, approved_by, dispatched_at, received_at, received_by) VALUES
 (current_setting('app.tenant_id')::uuid, '00000000-0000-0000-0000-0000000bd101', 'PD-1', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000bd01', 'in_transit', '00000000-0000-0000-0000-000000000a02', '00000000-0000-0000-0000-000000000a01', now(), NULL, NULL),
 (current_setting('app.tenant_id')::uuid, '00000000-0000-0000-0000-0000000bd102', 'PD-2', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000bd01', 'received', '00000000-0000-0000-0000-000000000a02', '00000000-0000-0000-0000-000000000a01', now(), now(), NULL),
 (current_setting('app.tenant_id')::uuid, '00000000-0000-0000-0000-0000000bd103', 'PD-3', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000bd01', 'cancelled', '00000000-0000-0000-0000-00000000dead', NULL, NULL, NULL, NULL);
INSERT INTO inventory.stock_transfer_line(tenant_id, id, transfer_id, tag_id, gross_wt, net_wt, received) VALUES
 (current_setting('app.tenant_id')::uuid, '00000000-0000-0000-0000-0000000bd111', '00000000-0000-0000-0000-0000000bd102', '00000000-0000-0000-0000-00000000f001', 1, 1, true);
INSERT INTO inventory.stock_take(tenant_id, id, branch_id, status, closed_at) VALUES
 (current_setting('app.tenant_id')::uuid, '00000000-0000-0000-0000-0000000bd121', '00000000-0000-0000-0000-00000000b001', 'closed', NULL);
COMMIT;
SQL
) || { echo "FAIL  PD2 fixture insert: $pdi"; LOG_FAIL=1; }
  pd1=$(pd_run)
  pd_delta=$(join -t'|' <(pd_counts "$pd0" | sort) <(pd_counts "$pd1" | sort) | awk -F'|' '$3 != $2 {print $1 "+" ($3 - $2)}' | sort | tr '\n' ' ')
  pd_rows=$(echo "$pd1" | grep '^row|sri-lakshmi|' | grep -c '0000000bd1')
  if [ "$pd_delta" = "inventory.stock_take.stock_take_closed_chk+1 inventory.stock_transfer.stock_transfer_cancelled_chk+1 inventory.stock_transfer.stock_transfer_dispatched_chk+2 inventory.stock_transfer.stock_transfer_received_chk+1 inventory.stock_transfer.stock_transfer_requested_by_fk+1 inventory.stock_transfer_line.stock_transfer_line_received_chk+1 " ] \
     && [ "$pd_rows" = 7 ] && echo "$pd1" | grep -q '^row|sri-lakshmi|inventory.stock_transfer|stock_transfer_dispatched_chk|00000000-0000-0000-0000-0000000bd101|'; then
    echo "PASS  PD2 violating 986-state rows: missing 988 columns treated as NULL (dispatch/cancel/line receipt), each counted and listed with slug, table, id"
  else echo "FAIL  PD2 pre-deploy violations: delta [$pd_delta] rows [$pd_rows] / $pd1"; LOG_FAIL=1; fi
  pdc=$(psql -h localhost -U app_migrator -d "$DB" -X -q -v ON_ERROR_STOP=1 2>&1 <<'SQL'
SET app.tenant_id = '00000000-0000-0000-0000-000000000001';
BEGIN;
DELETE FROM inventory.stock_take WHERE id = '00000000-0000-0000-0000-0000000bd121';
DELETE FROM inventory.stock_transfer_line WHERE id = '00000000-0000-0000-0000-0000000bd111';
DELETE FROM inventory.stock_transfer WHERE transfer_no IN ('PD-1','PD-2','PD-3');
DELETE FROM platform.branch WHERE id = '00000000-0000-0000-0000-00000000bd01';
COMMIT;
SQL
) || { echo "FAIL  PD3 fixture cleanup: $pdc"; LOG_FAIL=1; }
  pd2=$(pd_run)
  if [ "$(pd_counts "$pd2")" = "$(pd_counts "$pd0")" ]; then echo "PASS  PD3 fixtures removed: counts back to the 986 baseline"
  else echo "FAIL  PD3 baseline: $pd2"; LOG_FAIL=1; fi
  fi
  # SPD1–SPD3: sales pre-deploy NOT VALID check (seeds/check_sales_not_valid_predeploy.sql) at the dev 000–990 state, before 991+
  spd_run() { psql -h localhost -U app_rw -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -v slugs=sri-lakshmi -f seeds/check_sales_not_valid_predeploy.sql 2>&1; }
  spd0=$(spd_run); spd0_rc=$?
  if [ $spd0_rc -eq 0 ] && [ "$(echo "$spd0" | grep -c '^col|')" = 14 ] && ! echo "$spd0" | grep '^col|' | awk -F'|' '$4 != $6' | grep -q . \
     && [ "$(echo "$spd0" | grep -c '^count|')" = 19 ] && [ "$(echo "$spd0" | grep -c '^shop|sri-lakshmi|')" = 19 ]; then
    echo "PASS  SPD1 sales pre-check at 990: state markers as expected (990 present, 991+ absent), 19 constraint counts (total + per shop): $(echo "$spd0" | grep '^count|' | awk -F'|' '{s+=$4} END {print s+0}') violating rows"
  else echo "FAIL  SPD1 sales pre-check at 990: $spd0"; LOG_FAIL=1; fi
  # violating legacy rows written in ONE transaction that the pre-check's ROLLBACK discards (sales rows cannot be deleted)
  spd1=$( { cat <<'SQL'
SET app.tenant_id = '00000000-0000-0000-0000-000000000001';
SET app.user_id = '00000000-0000-0000-0000-000000000a01';
BEGIN;
SET LOCAL ROLE sales_writer;
INSERT INTO sales.doc_series(tenant_id, branch_id, doc_type, fy, prefix)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'tax_invoice', platform.fy_of(current_date), 'SPD/') ON CONFLICT DO NOTHING;
UPDATE sales.doc_series SET next_no = next_no + 1 WHERE tenant_id = platform.current_tenant() AND branch_id = '00000000-0000-0000-0000-00000000b001'
   AND doc_type = 'tax_invoice' AND fy = platform.fy_of(current_date) RETURNING next_no - 1 AS seq, prefix, fy \gset
INSERT INTO sales.invoice (tenant_id, id, branch_id, company_id, fy, doc_seq, doc_no, customer_snapshot, place_of_supply, gst_type, rate_snapshot,
   gross_value, taxable_value, cgst, sgst, round_off, invoice_total, net_payable, paid_amount, balance_due, created_by, salesperson_id, cash_counter_id)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000d5e01', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000c001',
   :'fy', :seq, :'prefix' || lpad(:'seq', 6, '0'), '{}', '33', 'intra', '{}', 1000, 1000, 15, 15, 0, 1030, 1030, 1030, 0, platform.current_user_id(),
   '00000000-0000-0000-0000-0000000dead1', '00000000-0000-0000-0000-0000000dead2');
INSERT INTO sales.invoice_line (tenant_id, invoice_id, line_no, line_kind, tag_id, item_id, description, purity_code, fineness, hsn, gross_wt, net_wt, rate_id, rate_per_g,
   metal_value, mc_type, mc_value, mc_amount, discount, taxable_value, tax_rule_id, tax_rate, hsn_sac_applied, composite_supply, cgst, sgst, igst, line_total)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000d5e01', 1, 'goods', '00000000-0000-0000-0000-0000000dead3', '00000000-0000-0000-0000-0000000dead4',
   'bad goods line', '22K', 916, '7113', 10, 11, '00000000-0000-0000-0000-0000000dead5', 7000, 1000, 'weird', 0, 0, -5, 1000,
   (SELECT id FROM masters.tax_rule WHERE scope = 'tenant' AND code = 'GOLD_JEWELLERY'), 3, '7113', false, 1, 1, 1, 999),
       (platform.current_tenant(), '00000000-0000-0000-0000-0000000d5e01', 2, 'goods', NULL, '00000000-0000-0000-0000-000000000901',
   'legacy zero-weight goods', '22K', 916, '9988', 0, 0, (SELECT id FROM rates.metal_rate WHERE kind = 'sale' LIMIT 1), 0, 0, 'flat', 0, 0, 0, 0,
   (SELECT id FROM masters.tax_rule WHERE scope = 'tenant' AND code = 'GOLD_JEWELLERY'), 3, '9988', false, 0, 0, 0, 0);
INSERT INTO sales.invoice_old_metal (tenant_id, invoice_id, line_no, purity_id, purity_code, gross_wt, less_wt, net_wt, touch_pct, fine_wt, rate_id, rate_per_g, amount)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-0000000d5e01', 1, '00000000-0000-0000-0000-0000000dead6', '22K', 2, 0, 3, 91.6, 1,
   '00000000-0000-0000-0000-0000000dead7', 6800, -1);
RESET ROLE;
INSERT INTO sales.estimate (tenant_id, branch_id, estimate_no, invoice_id, created_by)
VALUES (platform.current_tenant(), '00000000-0000-0000-0000-00000000b001', 'SPD-EST-1', '00000000-0000-0000-0000-0000000dead8', platform.current_user_id());
SQL
  cat seeds/check_sales_not_valid_predeploy.sql; } | sed 's/^\\set ON_ERROR_STOP 1$//' \
    | psql -h localhost -U app_rw -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -v slugs=sri-lakshmi 2>&1)
  spd_got=$(join -t'|' <(echo "$spd0" | grep '^count|' | cut -d'|' -f2,4 | sort) <(echo "$spd1" | grep '^count|' | cut -d'|' -f2,4 | sort) \
            | awk -F'|' '$3 != $2 {print $1 "+" ($3 - $2)}' | sed 's/^sales\.//' | sort | tr '\n' ' ')
  spd_want="estimate.estimate_invoice_fk+1 invoice.invoice_cash_counter_fk+1 invoice.invoice_salesperson_fk+1 invoice_line.invoice_line_amounts_check+1 invoice_line.invoice_line_gst_split_check+1 invoice_line.invoice_line_item_fk+1 invoice_line.invoice_line_mc_type_check+1 invoice_line.invoice_line_rate_fk+1 invoice_line.invoice_line_stock_check+2 invoice_line.invoice_line_tag_fk+1 invoice_line.invoice_line_total_sum_check+1 invoice_line.invoice_line_weights_check+2 invoice_old_metal.invoice_old_metal_amount_check+1 invoice_old_metal.invoice_old_metal_purity_fk+1 invoice_old_metal.invoice_old_metal_rate_fk+1 invoice_old_metal.invoice_old_metal_required_check+1 invoice_old_metal.invoice_old_metal_weights_check+1 "
  if [ "$spd_got" = "$spd_want" ] && echo "$spd1" | grep -q '^row|sri-lakshmi|sales.invoice_line|invoice_line_tag_fk|' \
     && echo "$spd1" | grep -q '^count|sales.invoice_line.invoice_line_stock_check|by_design|'; then
    echo "PASS  SPD2 violating 990-state rows counted per constraint (997 zero-weight goods included; new columns as NULL / 0; stock_check + old-gold required_check flagged by_design) and listed by id"
  else echo "FAIL  SPD2 sales pre-check violations: got [$spd_got] / $spd1"; LOG_FAIL=1; fi
  spd2=$(spd_run)
  if [ "$(echo "$spd2" | grep '^count|')" = "$(echo "$spd0" | grep '^count|')" ] \
     && [ "$(psql -h localhost -U app_migrator -d "$DB" -At -c "SELECT count(*) FROM sales.invoice WHERE id = '00000000-0000-0000-0000-0000000d5e01'")" = 0 ]; then
    echo "PASS  SPD3 the pre-check's ROLLBACK left nothing behind (counts back to the 990 baseline, fixture bill gone)"
  else echo "FAIL  SPD3: $spd2"; LOG_FAIL=1; fi
  p999_old=$(psql -h localhost -U app_rw -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -v slugs=sri-lakshmi,other-shop -f seeds/check_999_predeploy.sql 2>&1); p999_old_rc=$?
  if [ "$p999_old_rc" -eq 0 ] && grep -qx 'mode|filter' <<<"$p999_old" && p999_gate "$p999_old" 2; then
    echo 'PASS  P999-990 read-only app_rw pre-check at 990 (filter sri-lakshmi,other-shop): tenants|2, all 52 counts (19 Sales + 3 pin + 30 non-Sales) and 104 shop lines zero, document_print absent handled safely'
  else echo "FAIL  P999-990 pre-check: $p999_old"; LOG_FAIL=1; fi
  p999_old_all=$(psql -h localhost -U app_migrator -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -f seeds/check_999_predeploy.sql 2>&1); p999_old_all_rc=$?
  p999_old_n=$(p999_su "SELECT count(*) FROM platform.tenant")
  if [ "$p999_old_all_rc" -eq 0 ] && grep -qx 'mode|all' <<<"$p999_old_all" && p999_gate "$p999_old_all" "$p999_old_n" \
     && [ "$(echo "$p999_old_all" | grep '^info|tpl|')" = "$(p999_su "$P999_TPL_SQL")" ]; then
    echo "PASS  P999-990A default (all-tenant) pre-check at 990 as app_migrator: tenants|$p999_old_n = every platform.tenant row, 52 counts and $((52 * p999_old_n)) shop lines zero, info|tpl lines match the superuser count"
  else echo "FAIL  P999-990A default pre-check at 990 (n=$p999_old_n): $p999_old_all"; LOG_FAIL=1; fi
  # VS0: the VALIDATE seed refuses a DB without 991–998 (dev 990 state); its transaction is rolled back
  vs0=$(sudo -u postgres psql -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -f seeds/validate_sales_constraints.sql 2>&1); vs0_rc=$?
  if [ $vs0_rc -ne 0 ] && echo "$vs0" | grep -q '991–998 not applied' \
     && [ "$(sudo -u postgres psql -d "$DB" -At -c "SELECT count(*) FROM pg_constraint WHERE conname IN ('invoice_line_stock_check','invoice_old_metal_required_check')")" = 0 ]; then
    echo "PASS  VS0 validate seed refuses the 990 state (991–998 not applied), nothing changed"
  else echo "FAIL  VS0 validate seed at 990: rc=$vs0_rc $vs0"; LOG_FAIL=1; fi
  # Stage the pending chain at 995 first, then probe replacement against existing numbered notes and apply 996.
  # APPLIED stays 000–990; none of 991+ are added to its manifest by this test.
  : > /tmp/apply.log
  for f in $(migration_files); do
    grep -q " $(basename "$f")\$" migrations/APPLIED.sha256 && continue
    [ "${f##*/}" = 996_sales_gstr1_exclude_receipt_reversal.sql ] && break
    echo "applying $f" >> /tmp/apply.log
    psql -h localhost -U app_migrator -d "$DB" -X -q -v ON_ERROR_STOP=1 -f "$f" >> /tmp/apply.log 2>&1 || { cat /tmp/apply.log; exit 1; }
  done
  vs995=$(sudo -u postgres psql -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -f seeds/validate_sales_constraints.sql 2>&1); vs995_rc=$?
  if [ "$vs995_rc" -ne 0 ] && echo "$vs995" | grep -q '996 reports.gstr1_doc_summary.excluded_receipt_reversal_count'; then
    echo "PASS  GU2 validate seed refuses the 995 state (996 missing), nothing validated"
  else echo "FAIL  GU2 validate seed at 995: $vs995"; LOG_FAIL=1; fi
  sudo -u postgres psql -d "$DB" -X -q -v ON_ERROR_STOP=1 -v upgrade_995=1 -f tests/run_sales_gstr1_tests.sql || LOG_FAIL=1
  echo 'applying migrations/996_sales_gstr1_exclude_receipt_reversal.sql' >> /tmp/apply.log
  psql -h localhost -U app_migrator -d "$DB" -X -q -v ON_ERROR_STOP=1 -f migrations/996_sales_gstr1_exclude_receipt_reversal.sql >> /tmp/apply.log 2>&1 || { cat /tmp/apply.log; exit 1; }
  vs996=$(sudo -u postgres psql -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -f seeds/validate_sales_constraints.sql 2>&1); vs996_rc=$?
  if [ "$vs996_rc" -ne 0 ] && echo "$vs996" | grep -q '997 sales.document_print.doc_cancelled'; then
    echo "PASS  PU4 validate seed refuses the 996 state (997 missing), nothing validated"
  else echo "FAIL  PU4 validate seed at 996: $vs996"; LOG_FAIL=1; fi
  sudo -u postgres psql -d "$DB" -X -q -v ON_ERROR_STOP=1 -v upgrade_996=1 -f tests/run_sales_997_tests.sql || LOG_FAIL=1
  echo 'applying migrations/997_sales_print_cancelled_and_loose_weight.sql' >> /tmp/apply.log
  psql -h localhost -U app_migrator -d "$DB" -X -q -v ON_ERROR_STOP=1 -f migrations/997_sales_print_cancelled_and_loose_weight.sql >> /tmp/apply.log 2>&1 || { cat /tmp/apply.log; exit 1; }
  vs997=$(sudo -u postgres psql -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -f seeds/validate_sales_constraints.sql 2>&1); vs997_rc=$?
  if [ "$vs997_rc" -ne 0 ] && echo "$vs997" | grep -q '998 platform print defaults'; then
    echo "PASS  TU2 validate seed refuses 997 (998 print defaults missing), nothing validated"
  else echo "FAIL  TU2 validate seed at 997: $vs997"; LOG_FAIL=1; fi
  sudo -u postgres psql -d "$DB" -X -q -v ON_ERROR_STOP=1 -v upgrade_997=1 -v migration_sql="$(< migrations/998_print_template_platform_defaults.sql)" -f tests/run_print_template_defaults_tests.sql || LOG_FAIL=1
  echo 'applying migrations/998_print_template_platform_defaults.sql' >> /tmp/apply.log
  psql -h localhost -U app_migrator -d "$DB" -X -q -v ON_ERROR_STOP=1 -f migrations/998_print_template_platform_defaults.sql >> /tmp/apply.log 2>&1 || { cat /tmp/apply.log; exit 1; }
  sudo -u postgres psql -d "$DB" -X -q -v ON_ERROR_STOP=1 -v upgrade_998=1 -v migration_sql="$(< migrations/999_sales_print_pins_validate_legacy.sql)" -f tests/run_sales_999_tests.sql || LOG_FAIL=1
  echo 'applying migrations/999_sales_print_pins_validate_legacy.sql' >> /tmp/apply.log
  psql -h localhost -U app_migrator -d "$DB" -X -q -v ON_ERROR_STOP=1 -f migrations/999_sales_print_pins_validate_legacy.sql >> /tmp/apply.log 2>&1 || { cat /tmp/apply.log; exit 1; }
  echo 'ALL MIGRATIONS APPLIED (new, staged 995 -> 996 -> 997 -> 998 -> 999)'  >> /tmp/apply.log
  acl_post=$(psql -h localhost -U app_migrator -d "$DB" -At -c "$acl_sql")
  if [ -n "$acl_pre" ] && [ "$acl_pre" = "$acl_post" ]; then echo "PASS  MV1 upgrade: masters.metal/purity table grants unchanged by new migrations"
  else echo "FAIL  MV1 upgrade: metal/purity grants changed"; LOG_FAIL=1; fi
  pre=$(psql -h localhost -U app_migrator -d "$DB" -At -c "SET app.tenant_id='00000000-0000-0000-0000-000000000001';
        SELECT (SELECT count(*) FROM masters.metal WHERE version = 1 AND is_active) || '/' || (SELECT count(*) FROM masters.metal) || ' '
            || (SELECT count(*) FROM masters.purity WHERE version = 1 AND is_active) || '/' || (SELECT count(*) FROM masters.purity)" | tail -1)
  set -- ${pre//\// }
  if [ "$1" -ge 1 ] && [ "$1" = "$2" ] && [ "$3" -ge 1 ] && [ "$3" = "$4" ]; then echo "PASS  MV2 upgrade: seeded metal ($2) / purity ($4) rows got version 1, is_active true"
  else echo "FAIL  MV2 upgrade: existing rows ($pre)"; LOG_FAIL=1; fi
  grep -E "applying|ALL MIGRATIONS" /tmp/apply.log
else
  ./apply.sh "$DB" > /tmp/apply.log 2>&1 || { cat /tmp/apply.log; exit 1; }
  grep -E "applying|ALL MIGRATIONS" /tmp/apply.log
fi
# schema snapshot (before seed) so fresh and upgrade can be compared
sudo -u postgres pg_dump --schema-only -d "$DB" 2>/dev/null | grep -v '^-- Dumped\|^\\restrict\|^\\unrestrict' > "/tmp/dm_schema_$MODE.sql" \
  && echo "schema snapshot: /tmp/dm_schema_$MODE.sql ($(wc -l < /tmp/dm_schema_$MODE.sql) lines)"
[ "${SEEDED:-0}" = 1 ] || psql -h localhost -U app_migrator -d "$DB" -q -f tests/seed.sql
psql -h localhost -U app_rw -d "$DB" -q -v ON_ERROR_STOP=1 -f tests/run_tests.sql || LOG_FAIL=1
psql -h localhost -U app_rw -d "$DB" -q -v ON_ERROR_STOP=1 -f tests/run_masters_tests.sql || LOG_FAIL=1
psql -h localhost -U app_rw -d "$DB" -q -v ON_ERROR_STOP=1 -f tests/run_inventory_tests.sql || LOG_FAIL=1
psql -h localhost -U app_rw -d "$DB" -q -v ON_ERROR_STOP=1 -f tests/run_sales_tests.sql || LOG_FAIL=1
sudo -u postgres psql -d "$DB" -X -q -v ON_ERROR_STOP=1 -v upgrade_995=0 -f tests/run_sales_gstr1_tests.sql || LOG_FAIL=1
sudo -u postgres psql -d "$DB" -X -q -v ON_ERROR_STOP=1 -v upgrade_996=0 -f tests/run_sales_997_tests.sql || LOG_FAIL=1
sudo -u postgres psql -d "$DB" -X -q -v ON_ERROR_STOP=1 -v upgrade_997=0 -v migration_sql="$(< migrations/998_print_template_platform_defaults.sql)" -f tests/run_print_template_defaults_tests.sql || LOG_FAIL=1
sudo -u postgres psql -d "$DB" -X -q -v ON_ERROR_STOP=1 -v upgrade_998=0 -v migration_sql="$(< migrations/999_sales_print_pins_validate_legacy.sql)" -f tests/run_sales_999_tests.sql || LOG_FAIL=1
p999=$(psql -h localhost -U app_rw -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -v slugs=sri-lakshmi,other-shop -f seeds/check_999_predeploy.sql 2>&1); p999_rc=$?
if [ "$p999_rc" -eq 0 ] && grep -qx 'mode|filter' <<<"$p999" && p999_gate "$p999" 2 \
   && [ "$(echo "$p999" | grep -c '^info|tpl|')" = 14 ] && [ "$(echo "$p999" | grep -c '^info|tpl_total|')" = 7 ]; then
  echo 'PASS  P999 read-only app_rw pre-check (filter sri-lakshmi,other-shop): tenants|2, all 52 counts and 104 shop lines (52 per tenant) zero; 14 info|tpl + 7 info|tpl_total lines'
else echo "FAIL  P999 pre-check: $p999"; LOG_FAIL=1; fi
# P999-ALL: default mode = every tenant (as app_migrator, the role 999 runs as); compared with the superuser's view
p999_n=$(p999_su "SELECT count(*) FROM platform.tenant")
p999_slugs=$(p999_su "SELECT slug FROM platform.tenant ORDER BY slug")
p999_all=$(psql -h localhost -U app_migrator -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -f seeds/check_999_predeploy.sql 2>&1); p999_all_rc=$?
if [ "$p999_all_rc" -eq 0 ] && [ "$p999_n" -ge 2 ] && grep -qx 'mode|all' <<<"$p999_all" && p999_gate "$p999_all" "$p999_n" \
   && [ "$(echo "$p999_all" | grep '^shop|' | cut -d'|' -f2 | sort -u)" = "$(echo "$p999_slugs" | sort -u)" ] \
   && echo "$p999_all" | grep '^shop|' | cut -d'|' -f2 | sort | uniq -c | awk '$1!=52 {bad=1} END {exit bad}'; then
  echo "PASS  P999-ALL default pre-check covers every tenant: tenants|$p999_n, the shop slugs = all platform.tenant slugs, 52 each, all zero"
else echo "FAIL  P999-ALL default pre-check (n=$p999_n slugs=$(echo $p999_slugs)): $p999_all"; LOG_FAIL=1; fi
if [ "$(echo "$p999_all" | grep '^info|tpl|')" = "$(p999_su "$P999_TPL_SQL")" ] && [ "$(echo "$p999_all" | grep '^info|tpl_total|')" = "$(p999_su "$P999_TOT_SQL")" ] \
   && [ "$(echo "$p999_all" | grep -c '^info|tpl|')" = $((7 * p999_n)) ] && [ "$(echo "$p999_all" | grep -c '^info|tpl_scope|')" = 1 ]; then
  echo "PASS  P999-INFO info|tpl ($((7 * p999_n)) lines, 7 doc types incl. tag_label per tenant) and info|tpl_total lines equal the superuser's count of active tenant + own-partner templates"
else echo "FAIL  P999-INFO: got $(echo "$p999_all" | grep '^info|') want $(p999_su "$P999_TPL_SQL") $(p999_su "$P999_TOT_SQL")"; LOG_FAIL=1; fi
# P999-ALL-RW / -SU: app_rw cannot list every tenant -> loud stop, nothing certified; a superuser (RLS ignored) is refused
p999_rw=$(psql -h localhost -U app_rw -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -f seeds/check_999_predeploy.sql 2>&1); p999_rw_rc=$?
if [ "$p999_rw_rc" -ne 0 ] && grep -q 'cannot enumerate every tenant' <<<"$p999_rw" && ! grep -qE '^(tenants|shop|count)\|' <<<"$p999_rw"; then
  echo 'PASS  P999-ALL-RW default mode as app_rw stops loudly (cannot enumerate every tenant under RLS); no tenants/shop/count line printed'
else echo "FAIL  P999-ALL-RW: rc=$p999_rw_rc $p999_rw"; LOG_FAIL=1; fi
p999_su_out=$(sudo -u postgres psql -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -f seeds/check_999_predeploy.sql 2>&1); p999_su_rc=$?
if [ "$p999_su_rc" -ne 0 ] && grep -q 'superuser/BYPASSRLS' <<<"$p999_su_out" && ! grep -qE '^(tenants|shop|count)\|' <<<"$p999_su_out"; then
  echo 'PASS  P999-ALL-SU a superuser session is refused (RLS ignored; counts would not be per tenant)'
else echo "FAIL  P999-ALL-SU: rc=$p999_su_rc $p999_su_out"; LOG_FAIL=1; fi
# P999-FILTER: -v slugs is a filter; an unknown slug aborts
p999_f=$(psql -h localhost -U app_rw -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -v slugs=other-shop -f seeds/check_999_predeploy.sql 2>&1); p999_f_rc=$?
if [ "$p999_f_rc" -eq 0 ] && grep -qx 'mode|filter' <<<"$p999_f" && p999_gate "$p999_f" 1 \
   && [ "$(echo "$p999_f" | grep -E '^shop\|' | cut -d'|' -f2 | sort -u)" = other-shop ] \
   && [ "$(echo "$p999_f" | grep '^info|tpl|')" = "$(p999_su "$P999_TPL_SQL" | grep '^info|tpl|other-shop|')" ]; then
  echo 'PASS  P999-FILTER app_rw -v slugs=other-shop: tenants|1, 52 shop lines for other-shop only, info|tpl lines for other-shop only'
else echo "FAIL  P999-FILTER: rc=$p999_f_rc $p999_f"; LOG_FAIL=1; fi
p999_f2=$(psql -h localhost -U app_rw -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -v slugs=other-shop,no-such-shop -f seeds/check_999_predeploy.sql 2>&1); p999_f2_rc=$?
if [ "$p999_f2_rc" -ne 0 ] && grep -q 'unknown tenant slug no-such-shop' <<<"$p999_f2" && ! grep -qE '^(tenants|shop|count)\|' <<<"$p999_f2"; then
  echo 'PASS  P999-FILTER2 an unknown slug in the filter aborts before any count'
else echo "FAIL  P999-FILTER2: rc=$p999_f2_rc $p999_f2"; LOG_FAIL=1; fi
# P999-UNL: fixture tenants in no slug list; the violation in p999-unlisted-a shows in default mode; the filter mode does not certify it
p999_u=$( { p999_fixture; cat seeds/check_999_predeploy.sql; } | sed 's/^\\set ON_ERROR_STOP 1$//' \
  | psql -h localhost -U app_migrator -d "$DB" -X -q -At -v ON_ERROR_STOP=1 2>&1); p999_u_rc=$?
p999_u_nz=$(echo "$p999_u" | grep -E '^(count|shop)\|' | awk -F'|' '$NF!=0' | sort | tr '\n' ' ')
p999_u_want="count|masters.value_addition_rule.var_metal_fk|1 count|masters.value_addition_rule.var_weight_band|1 shop|p999-unlisted-a|masters.value_addition_rule.var_metal_fk|1 shop|p999-unlisted-a|masters.value_addition_rule.var_weight_band|1 "
if [ "$p999_u_rc" -eq 0 ] && grep -qx "tenants|$((p999_n + 2))" <<<"$p999_u" && [ "$p999_u_nz" = "$p999_u_want" ] \
   && [ "$(echo "$p999_u" | grep -c '^shop|')" = $((52 * (p999_n + 2))) ] && [ "$(echo "$p999_u" | grep -c '^count|')" = 52 ] \
   && grep -qx 'row|p999-unlisted-a|masters.value_addition_rule.var_metal_fk|00000000-0000-4000-8000-0000000ea99c' <<<"$p999_u" \
   && grep -qx 'row|p999-unlisted-a|masters.value_addition_rule.var_weight_band|00000000-0000-4000-8000-0000000ea99c' <<<"$p999_u"; then
  echo "PASS  P999-UNL default mode covers tenants in no slug list (tenants|$((p999_n + 2))) and flags the violation in p999-unlisted-a (count, shop, row); every other line 0"
else echo "FAIL  P999-UNL: rc=$p999_u_rc got [$p999_u_nz] / $p999_u"; LOG_FAIL=1; fi
p999_u_tpl=$(echo "$p999_u" | grep -E '^info\|tpl\|p999-unlisted-' | tr '\n' ' ')
p999_u_tpl_want="info|tpl|p999-unlisted-a|credit_note|0 info|tpl|p999-unlisted-a|estimate|0 info|tpl|p999-unlisted-a|invoice|1 info|tpl|p999-unlisted-a|order_receipt|0 info|tpl|p999-unlisted-a|rate_card|0 info|tpl|p999-unlisted-a|receipt|1 info|tpl|p999-unlisted-a|tag_label|2 info|tpl|p999-unlisted-b|credit_note|0 info|tpl|p999-unlisted-b|estimate|0 info|tpl|p999-unlisted-b|invoice|0 info|tpl|p999-unlisted-b|order_receipt|0 info|tpl|p999-unlisted-b|rate_card|0 info|tpl|p999-unlisted-b|receipt|1 info|tpl|p999-unlisted-b|tag_label|1 "
p999_tot_ok=1
for d in credit_note:0 estimate:0 invoice:1 order_receipt:0 rate_card:0 receipt:1 tag_label:2; do
  b=$(echo "$p999_all" | grep "^info|tpl_total|${d%%:*}|" | cut -d'|' -f4); a=$(echo "$p999_u" | grep "^info|tpl_total|${d%%:*}|" | cut -d'|' -f4)
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" = $((b + ${d##*:})) ] || p999_tot_ok=0
done
if [ "$p999_u_tpl" = "$p999_u_tpl_want" ] && [ "$p999_tot_ok" = 1 ]; then
  echo 'PASS  P999-INFO2 fixture: tenant + partner, active + inactive templates (invoice, estimate, receipt, rate_card, tag_label): only active ones count; partner templates visible under both tenants RLS; totals +1 invoice, +1 receipt, +2 tag_label (shared partner template counted once)'
else echo "FAIL  P999-INFO2: got [$p999_u_tpl] totals_ok=$p999_tot_ok / $(echo "$p999_u" | grep '^info|tpl_total|')"; LOG_FAIL=1; fi
p999_uf=$( { p999_fixture; cat seeds/check_999_predeploy.sql; } | sed 's/^\\set ON_ERROR_STOP 1$//' \
  | psql -h localhost -U app_migrator -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -v slugs=sri-lakshmi,other-shop 2>&1); p999_uf_rc=$?
if [ "$p999_uf_rc" -eq 0 ] && grep -qx 'mode|filter' <<<"$p999_uf" && p999_gate "$p999_uf" 2; then
  echo 'PASS  P999-UNL2 the same violation is invisible to -v slugs=sri-lakshmi,other-shop (filter certifies only listed tenants), which is why the gate uses the default'
else echo "FAIL  P999-UNL2: rc=$p999_uf_rc $p999_uf"; LOG_FAIL=1; fi
if [ "$(p999_su "SELECT count(*) FROM platform.tenant WHERE slug LIKE 'p999-%'")" = 0 ] && [ "$(p999_su "SELECT count(*) FROM platform.tenant")" = "$p999_n" ]; then
  echo 'PASS  P999-UNL3 the fixture transaction was rolled back (no p999-* tenants, tenant count unchanged)'
else echo 'FAIL  P999-UNL3 fixture left rows behind'; LOG_FAIL=1; fi
# P999-PC: one violating row per new pre-check family (NB-1a type mismatch, inventory CHECK, masters CHECK + FK), written by the
# owner in ONE transaction (constraint dropped, row written, re-added NOT VALID) that the pre-check's own ROLLBACK discards.
p999_bad=$( { cat <<'SQL'
SET app.tenant_id = '00000000-0000-0000-0000-000000000001';
SET app.user_id = '00000000-0000-0000-0000-000000000a01';
SET app.partner_id = '';
SET app.branch_scope = '';
BEGIN;
SELECT pg_get_constraintdef(oid) || ' NOT VALID' AS fk_def FROM pg_constraint WHERE conrelid = 'sales.document_print'::regclass AND conname = 'document_print_template_fk' \gset
SELECT pg_get_constraintdef(oid) || ' NOT VALID' AS vwb_def FROM pg_constraint WHERE conrelid = 'masters.value_addition_rule'::regclass AND conname = 'var_weight_band' \gset
SELECT pg_get_constraintdef(oid) || ' NOT VALID' AS vmf_def FROM pg_constraint WHERE conrelid = 'masters.value_addition_rule'::regclass AND conname = 'var_metal_fk' \gset
SELECT pg_get_constraintdef(oid) || ' NOT VALID' AS tsg_def FROM pg_constraint WHERE conrelid = 'inventory.tag'::regclass AND conname = 'tag_stone_le_gross' \gset
ALTER TABLE sales.document_print DROP CONSTRAINT document_print_template_fk;
INSERT INTO sales.document_print(tenant_id, id, branch_id, doc_type, doc_id, print_no, copy, paper, printed_by, template_id, template_version)
VALUES (platform.current_tenant(), '00000000-0000-4000-8000-000000ec0999', '00000000-0000-0000-0000-00000000b001', 'estimate', gen_random_uuid(), 1, 'original', 'A4',
        platform.current_user_id(), '01a1c455-29fa-769b-84f9-377a9bcdab46', 1);
ALTER TABLE sales.document_print ADD CONSTRAINT document_print_template_fk :fk_def;
ALTER TABLE masters.value_addition_rule DROP CONSTRAINT var_weight_band, DROP CONSTRAINT var_metal_fk;
INSERT INTO masters.value_addition_rule(tenant_id, id, scope, metal_id, weight_from, weight_to)
VALUES (platform.current_tenant(), '00000000-0000-4000-8000-000000ec099a', 'customer', '00000000-0000-0000-0000-00000000dead', 5, 1);
ALTER TABLE masters.value_addition_rule ADD CONSTRAINT var_weight_band :vwb_def, ADD CONSTRAINT var_metal_fk :vmf_def;
ALTER TABLE inventory.tag DROP CONSTRAINT tag_stone_le_gross;
UPDATE inventory.tag SET stone_wt = gross_wt + 1 WHERE id = '00000000-0000-0000-0000-00000000f002';
ALTER TABLE inventory.tag ADD CONSTRAINT tag_stone_le_gross :tsg_def;
SQL
  cat seeds/check_999_predeploy.sql; } | sed 's/^\\set ON_ERROR_STOP 1$//' \
  | psql -h localhost -U app_migrator -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -v slugs=sri-lakshmi,other-shop 2>&1); p999_bad_rc=$?
p999_bad_nz=$(echo "$p999_bad" | grep -E '^(count|shop)\|' | awk -F'|' '$NF!=0' | sort | tr '\n' ' ')
p999_bad_want="count|inventory.tag.tag_stone_le_gross|1 count|masters.value_addition_rule.var_metal_fk|1 count|masters.value_addition_rule.var_weight_band|1 count|sales.document_print.template_doc_type_mismatch|1 shop|sri-lakshmi|inventory.tag.tag_stone_le_gross|1 shop|sri-lakshmi|masters.value_addition_rule.var_metal_fk|1 shop|sri-lakshmi|masters.value_addition_rule.var_weight_band|1 shop|sri-lakshmi|sales.document_print.template_doc_type_mismatch|1 "
if [ "$p999_bad_rc" -eq 0 ] && [ "$p999_bad_nz" = "$p999_bad_want" ] && [ "$(echo "$p999_bad" | grep -c '^count|')" = 52 ] \
   && grep -qx 'row|sri-lakshmi|sales.document_print.template_doc_type_mismatch|00000000-0000-4000-8000-000000ec0999' <<<"$p999_bad" \
   && grep -qx 'row|sri-lakshmi|masters.value_addition_rule.var_metal_fk|00000000-0000-4000-8000-000000ec099a' <<<"$p999_bad" \
   && grep -qx 'row|sri-lakshmi|inventory.tag.tag_stone_le_gross|00000000-0000-0000-0000-00000000f002' <<<"$p999_bad"; then
  echo 'PASS  P999-PC pre-check flags a mismatched print pin type and inventory/masters CHECK + FK violations (count, shop and row lines); every other line 0'
else echo "FAIL  P999-PC pre-check violations: rc=$p999_bad_rc got [$p999_bad_nz] / $p999_bad"; LOG_FAIL=1; fi
p999_after=$(psql -h localhost -U app_rw -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -v slugs=sri-lakshmi,other-shop -f seeds/check_999_predeploy.sql 2>&1)
if ! echo "$p999_after" | grep -E '^(count|shop)\|' | awk -F'|' '$NF!=0 {bad=1} END {exit !bad}' && [ "$(echo "$p999_after" | grep -c '^count|')" = 52 ] \
   && [ "$(psql -h localhost -U app_migrator -d "$DB" -X -At -c "SELECT count(*) FROM pg_constraint WHERE NOT convalidated")" = 0 ]; then
  echo 'PASS  P999-PC2 the ROLLBACK left nothing behind: 52 counts zero again, 0 NOT VALID constraints in the catalogue'
else echo "FAIL  P999-PC2: $p999_after"; LOG_FAIL=1; fi
if grep -q '^BEGIN READ ONLY;$' seeds/check_999_predeploy.sql && [ "$(grep -c '^ROLLBACK;$' seeds/check_999_predeploy.sql)" = 1 ] \
   && grep -q '^SET default_transaction_read_only=on;$' seeds/check_999_predeploy.sql \
   && ! grep -v '^ *--' seeds/check_999_predeploy.sql | grep -qiE '\b(validate|insert|update|delete|alter|truncate|commit|create|drop|grant|revoke)\b'; then
  echo 'PASS  P999-RO pre-check is read-only by construction (read-only default + BEGIN READ ONLY … ROLLBACK, no write / DDL / VALIDATE keyword)'
else echo 'FAIL  P999-RO pre-check contains a write keyword'; LOG_FAIL=1; fi
echo '--- owner-level bypass attempts (app_migrator)'
psql -h localhost -U app_migrator -d "$DB" -q -At -v ON_ERROR_STOP=1 -f tests/run_owner_tests.sql || LOG_FAIL=1
echo '--- pg-boss worker (app_worker)'
psql -h localhost -U app_worker -d "$DB" -q -At -v ON_ERROR_STOP=1 -f tests/run_worker_tests.sql || LOG_FAIL=1
out=$(PGPASSWORD=dev psql -h localhost -U app_worker -d "$DB" -At -c "ALTER TABLE notifications.outbox ADD COLUMN x int" 2>&1)
if echo "$out" | grep -qE "owner|blocked|permission"; then echo "PASS  worker cannot ALTER outbox table"; else echo "FAIL  worker ALTER outbox: $out"; fi

echo '--- (c) schema-change guard'
out=$(sudo -u postgres psql -d "$DB" -At -c "CREATE TABLE sales.shadow_invoice(id int)" 2>&1)
if echo "$out" | grep -q "blocked"; then echo "PASS  (c) superuser DDL in sales schema blocked -> $out"; else echo "FAIL  (c) superuser DDL not blocked: $out"; LOG_FAIL=1; fi
out=$(sudo -u postgres psql -d "$DB" -At -c "DROP VIEW reports.series_summary" 2>&1)
if echo "$out" | grep -q "blocked"; then echo "PASS  (c) superuser DROP of gap report blocked"; else echo "FAIL  (c) DROP not blocked: $out"; LOG_FAIL=1; fi
out=$(sudo -u postgres psql -d "$DB" -At -c "ALTER TABLE sales.invoice DISABLE TRIGGER invoice_guard" 2>&1)
if echo "$out" | grep -q "blocked"; then echo "PASS  (c) superuser cannot disable invoice trigger"; else echo "FAIL  (c) trigger disable not blocked: $out"; LOG_FAIL=1; fi
n=$(sudo -u postgres psql -d "$DB" -At -c "SELECT count(*) FROM public.schema_change_log WHERE session_user_name='app_migrator'")
if [ "$n" -gt 100 ]; then echo "PASS  (c) migration DDL logged ($n entries in schema_change_log)"; else echo "FAIL  (c) DDL log has $n entries"; LOG_FAIL=1; fi

echo '--- P23 platform admin console (app_admin)'
PGPASSWORD=dev psql -h localhost -U app_admin -d "$DB" -At -v ON_ERROR_STOP=1 <<'SQL' || LOG_FAIL=1
\pset tuples_only on
CREATE FUNCTION pg_temp.check(ok boolean, p_label text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN IF ok THEN RETURN 'PASS  ' || p_label; END IF; RAISE EXCEPTION 'FAIL  %', p_label; END $$;
SELECT pg_temp.check((SELECT count(*) FROM platform.tenant) = 2, 'P23 admin lists all shops');
SELECT pg_temp.check((SELECT count(*) FROM billing.subscription) = 2, 'P23 admin sees every shop subscription/usage');
UPDATE platform.tenant SET status = 'suspended', suspended_at = now(), suspend_reason = 'non-payment' WHERE slug = 'other-shop';
SELECT pg_temp.check((SELECT status FROM platform.tenant WHERE slug = 'other-shop') = 'suspended', 'P23 admin can suspend a shop');
UPDATE platform.tenant SET status = 'active', suspended_at = NULL, suspend_reason = NULL WHERE slug = 'other-shop';
DO $$ BEGIN PERFORM 1 FROM sales.invoice; RAISE EXCEPTION 'FAIL  admin read invoices';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS  P23 admin cannot read shop sales (permission denied)'; END $$;
DO $$ BEGIN PERFORM 1 FROM masters.customer; RAISE EXCEPTION 'FAIL  admin read customers';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS  P23 admin cannot read shop customers'; END $$;
INSERT INTO platform.platform_admin_session(admin_id, token_hash, expires_at)
SELECT id, sha256('admintok'), now() + interval '1 hour' FROM platform.platform_admin WHERE email = 'ops@jewelos.in';
SELECT pg_temp.check((SELECT count(*) FROM platform.platform_admin_session) = 1, 'R4 admin console creates a hashed-token session');
DO $$ BEGIN INSERT INTO platform.platform_admin_session(admin_id, token_hash, expires_at)
  SELECT id, 'plain', now() FROM platform.platform_admin; RAISE EXCEPTION 'FAIL  plaintext admin token accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS  R4 admin session token must be a 32-byte hash'; END $$;
SELECT pg_temp.check(platform.provision_tenant('ganesh-gold','Ganesh Gold',NULL,'Ganesh Gold Pvt Ltd','33ABCDE1234F1Z5','ABCDE1234F','33',
        'mdu','Madurai','Ganesh','9000000777','ganesh','$argon2id$h','ta') IS NOT NULL, 'R6 provision_tenant runs in one call');
SELECT pg_temp.check((SELECT status || '/' || default_language FROM platform.tenant WHERE slug = 'ganesh-gold') = 'trial/ta', 'R6 tenant created as trial with language');
DO $$ BEGIN PERFORM platform.provision_tenant('half-made','Half',NULL,'Half Ltd','BADGSTIN','ABCDE1234F','33','m','M','O','9000000778','owner2','h');
  RAISE EXCEPTION 'FAIL  bad provisioning accepted';
EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF; RAISE NOTICE 'PASS  R6 failing step aborts the whole provisioning (%)', SQLERRM; END $$;
SELECT pg_temp.check((SELECT count(*) FROM platform.tenant WHERE slug = 'half-made') = 0, 'R6 no half-provisioned tenant left behind');
SELECT pg_temp.check(coalesce(current_setting('app.tenant_id', true), '') = '', 'R6 caller tenant context restored');
SELECT pg_temp.check(platform.provision_tenant('dedi-gold','Dedi Gold',NULL,'Dedi Gold Ltd',NULL,NULL,'29','blr','Bengaluru','D','9000000888','dedi','$argon2id$h','kn','dedicated') IS NOT NULL, 'S5 provision_tenant accepts p_deployment_mode');
SELECT pg_temp.check((SELECT deployment_mode FROM platform.tenant WHERE slug = 'dedi-gold') = 'dedicated', 'S5 deployment_mode stored on tenant');
DO $$ BEGIN PERFORM platform.provision_tenant('cloudy','C',NULL,'C Ltd',NULL,NULL,'29','c','C','C','9000000889','cloudy','h','en','cloud');
  RAISE EXCEPTION 'FAIL  bad deployment mode accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS  S5 invalid deployment_mode rejected (CHECK)'; END $$;
SELECT pg_temp.check(platform.provision_tenant('null-pfx','Null Pfx',NULL,'Null Pfx Ltd',NULL,NULL,'33','tpr','Tiruppur','N','9000000890','nullpfx','$argon2id$h','en','shared',NULL) IS NOT NULL, 'BP1 provision_tenant accepts explicit NULL prefix');
SELECT pg_temp.check(platform.provision_tenant('cust-pfx','Cust Pfx',NULL,'Cust Pfx Ltd',NULL,NULL,'33','slm','Salem','C','9000000891','custpfx','$argon2id$h','ta','shared','sl/gs-1') IS NOT NULL, 'BP2 provision_tenant accepts a custom prefix');
DO $$ BEGIN PERFORM platform.provision_tenant('bad-pfx','B',NULL,'B Ltd',NULL,NULL,'33','b','B','B','9000000892','badpfx','h','en','shared','BAD PFX!');
  RAISE EXCEPTION 'FAIL  invalid prefix accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS  BP3 invalid prefix (space/!) rejected'; END $$;
DO $$ BEGIN PERFORM platform.provision_tenant('long-pfx','L',NULL,'L Ltd',NULL,NULL,'33','l','L','L','9000000893','longpfx','h','en','shared','ABCDEFGHIJKLM');
  RAISE EXCEPTION 'FAIL  13-char prefix accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS  BP4 13-char prefix rejected'; END $$;
DO $$ BEGIN PERFORM platform.provision_tenant('dash-pfx','D',NULL,'D Ltd',NULL,NULL,'33','d','D','D','9000000894','dashpfx','h','en','shared','-CBE');
  RAISE EXCEPTION 'FAIL  leading-dash prefix accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS  BP5 prefix must start with a letter/digit'; END $$;
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM platform.tenant WHERE slug IN ('bad-pfx','long-pfx','dash-pfx')), 'BP6 rejected prefix leaves no tenant behind');
SELECT pg_temp.check(NOT has_function_privilege('app_admin', 'platform.audit_append(uuid,text,text,uuid,jsonb,jsonb)', 'EXECUTE'), 'S6 app_admin has no audit_append');
SELECT pg_temp.check(has_function_privilege('tenant_provisioner', 'platform.audit_append(uuid,text,text,uuid,jsonb,jsonb)', 'EXECUTE'), 'S6 provisioner owner role has audit_append');
INSERT INTO platform.rate_limit_bucket(bucket_key, window_start, count) VALUES ('login.admin:-:' || encode(sha256('ops@jewelos.in'),'hex'), now(), 1);
SELECT pg_temp.check((SELECT count(*) FROM platform.rate_limit_bucket WHERE bucket_key LIKE 'login.admin:%') = 1, 'S2 admin console uses rate_limit_bucket');
SQL
sudo -u postgres psql -d "$DB" -At -v ON_ERROR_STOP=1 <<'SQL' || LOG_FAIL=1
SELECT CASE WHEN (SELECT count(*) FROM platform.company c JOIN platform.tenant t ON t.id = c.tenant_id WHERE t.slug = 'ganesh-gold') = 1
         AND (SELECT count(*) FROM platform.branch b JOIN platform.tenant t ON t.id = b.tenant_id WHERE t.slug = 'ganesh-gold' AND b.bill_series_prefix = 'MDU') = 1
         AND (SELECT count(*) FROM platform.role r JOIN platform.tenant t ON t.id = r.tenant_id WHERE t.slug = 'ganesh-gold') = 4
         AND (SELECT count(*) FROM platform.user_role ur JOIN platform.role r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
              JOIN platform.tenant t ON t.id = r.tenant_id WHERE t.slug = 'ganesh-gold' AND r.system_role_code = 'owner') = 1
         AND (SELECT count(*) FROM platform.onboarding_progress o JOIN platform.tenant t ON t.id = o.tenant_id WHERE t.slug = 'ganesh-gold' AND o.status = 'pending') = 10
         AND (SELECT count(*) FROM platform.setting s JOIN platform.tenant t ON t.id = s.tenant_id WHERE t.slug = 'ganesh-gold') = 0
       THEN 'PASS  R6 provisioned company, branch (prefix MDU), 4 roles, owner, 10 pending onboarding steps; settings inherit defaults'
       ELSE 'FAIL  R6 provisioned rows incomplete' END;
SELECT CASE WHEN (SELECT count(*) FROM masters.hsn_code h JOIN platform.tenant t ON t.id = h.tenant_id WHERE t.slug = 'ganesh-gold') = 12
             AND NOT EXISTS ((SELECT code_type, code, description, uqc FROM platform.hsn_code_default)
                             EXCEPT (SELECT h.code_type, h.code, h.description, h.uqc FROM masters.hsn_code h JOIN platform.tenant t ON t.id = h.tenant_id WHERE t.slug = 'ganesh-gold'))
             AND (SELECT count(*) FROM masters.hsn_code h JOIN platform.tenant t ON t.id = h.tenant_id WHERE t.slug IN ('half-made','bad-pfx','long-pfx','dash-pfx')) = 0
       THEN 'PASS  HP1 provision_tenant seeds exactly the 12 default HSN/SAC codes; failed provisioning leaves none'
       ELSE 'FAIL  HP1 provisioned HSN codes wrong' END;
SELECT CASE WHEN (SELECT b.bill_series_prefix FROM platform.branch b JOIN platform.tenant t ON t.id = b.tenant_id WHERE t.slug = 'null-pfx') = 'TPR'
             AND (SELECT b.bill_series_prefix FROM platform.branch b JOIN platform.tenant t ON t.id = b.tenant_id WHERE t.slug = 'cust-pfx') = 'SL/GS-1'
             AND (SELECT b.code FROM platform.branch b JOIN platform.tenant t ON t.id = b.tenant_id WHERE t.slug = 'cust-pfx') = 'SLM'
       THEN 'PASS  BP7 NULL prefix -> upper(branch code) TPR; custom prefix stored upper-cased SL/GS-1, branch code unchanged'
       ELSE 'FAIL  BP7 prefixes wrong' END;
SELECT CASE WHEN (SELECT new_row->>'bill_series_prefix' FROM platform.audit_event e JOIN platform.tenant t ON t.id = e.tenant_id
                  WHERE t.slug = 'cust-pfx' AND e.action = 'tenant.provisioned') = 'SL/GS-1'
             AND (SELECT new_row->>'bill_series_prefix' FROM platform.audit_event e JOIN platform.tenant t ON t.id = e.tenant_id
                  WHERE t.slug = 'null-pfx' AND e.action = 'tenant.provisioned') = 'TPR'
       THEN 'PASS  BP8 tenant.provisioned audit event carries bill_series_prefix'
       ELSE 'FAIL  BP8 audit event lacks prefix' END;
SELECT CASE WHEN (SELECT count(*) FROM pg_proc p WHERE p.proname = 'provision_tenant' AND p.pronamespace = 'platform'::regnamespace) = 1
             AND (SELECT pronargs || '/' || pronargdefaults || '/' || prosecdef || '/' || pg_get_userbyid(proowner) || '/' || array_to_string(proconfig, ',')
                  FROM pg_proc WHERE proname = 'provision_tenant') = '16/3/true/tenant_provisioner/search_path=pg_catalog, pg_temp'
             AND has_function_privilege('app_admin', 'platform.provision_tenant(text,text,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text)', 'EXECUTE')
             AND NOT has_function_privilege('app_rw', 'platform.provision_tenant(text,text,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text)', 'EXECUTE')
             AND NOT has_function_privilege('app_ro', 'platform.provision_tenant(text,text,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text)', 'EXECUTE')
       THEN 'PASS  BP9 single 16-arg provision_tenant (no overloads), SECURITY DEFINER, owner/search_path kept, app_admin-only EXECUTE'
       ELSE 'FAIL  BP9 provision_tenant signature/grants wrong' END;
SELECT CASE WHEN (SELECT count(*) FROM platform.audit_event e JOIN platform.tenant t ON t.id = e.tenant_id
                  WHERE t.slug IN ('ganesh-gold','dedi-gold') AND e.action = 'tenant.provisioned') = 2
             AND (SELECT new_row->>'deployment_mode' FROM platform.audit_event e JOIN platform.tenant t ON t.id = e.tenant_id
                  WHERE t.slug = 'dedi-gold' AND e.action = 'tenant.provisioned') = 'dedicated'
       THEN 'PASS  S6 provision_tenant writes a tenant.provisioned audit event internally'
       ELSE 'FAIL  S6 provisioning audit event missing' END;
SQL

echo '--- concurrency: 30 parallel invoice issues from separate connections'
for n in $(seq 1 30); do
  psql -h localhost -U app_rw -d "$DB" -q -v ON_ERROR_STOP=1 -v tag= \
    -c "SELECT set_config('app.tenant_id','00000000-0000-0000-0000-000000000001',false), set_config('app.user_id','00000000-0000-0000-0000-000000000a01',false)" \
    -f tests/issue_invoice_uow.sql > /dev/null 2>/tmp/conc_$n.err || echo "worker $n failed: $(cat /tmp/conc_$n.err)" &
done
wait
res=$(psql -h localhost -U app_ro -d "$DB" -At -c "SET app.tenant_id='00000000-0000-0000-0000-000000000001';
  SELECT count(*) || ' ' || max(doc_seq) || ' ' || (SELECT count(*) FROM reports.series_gaps) FROM sales.invoice" | tail -1)
set -- $res
if [ "$1" = "$2" ] && [ "$3" = "0" ] && [ "$1" -ge 30 ]; then echo "PASS  30 parallel issuers: $1 invoices, numbers 1..$2, gaps=$3"
else echo "FAIL  concurrency: invoices=$1 max=$2 gaps=$3"; fi
echo '--- IK25 concurrent same idempotency key: second insert waits, then unique_violation after the first commits'
ik_ins="INSERT INTO platform.idempotency_key(tenant_id, scope, key, request_hash, response_status, response_body)
        VALUES (platform.current_tenant(), 'POST /v1/settings/gst-config/{id}/replace', 'idem-race-0001', 'h', 200, '{}')"
PGOPTIONS='-c app.tenant_id=00000000-0000-0000-0000-000000000001' psql -h localhost -U app_rw -d "$DB" -q -v ON_ERROR_STOP=1 \
  -c "BEGIN" -c "$ik_ins" -c "SELECT pg_sleep(2)" -c "COMMIT" > /tmp/ik_a.out 2>&1 & ik_a=$!
sleep 0.7
t0=$(date +%s.%N)
PGOPTIONS='-c app.tenant_id=00000000-0000-0000-0000-000000000001' psql -h localhost -U app_rw -d "$DB" -q -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
  -c "$ik_ins" > /tmp/ik_b.out 2>&1; ik_b=$?
t1=$(date +%s.%N); wait $ik_a; ik_a_rc=$?
waited=$(awk -v a="$t0" -v b="$t1" 'BEGIN{print (b - a > 1.0) ? 1 : 0}')
if [ $ik_a_rc -eq 0 ] && [ $ik_b -ne 0 ] && grep -q "23505" /tmp/ik_b.out && grep -q "idempotency_key_pkey" /tmp/ik_b.out && [ "$waited" = 1 ]; then
  echo "PASS  IK25 first commits; concurrent second insert blocked until then and got 23505 unique_violation"
else echo "FAIL  IK25 concurrent same key (a=$ik_a_rc b=$ik_b waited=$waited): $(head -3 /tmp/ik_b.out)"; LOG_FAIL=1; fi
echo '--- 983 HSN backfill (seeds/backfill_hsn_codes.sql as app_rw = dev_seed privileges)'
r1=$(psql -h localhost -U app_rw -d "$DB" -X -q -v ON_ERROR_STOP=1 -v slugs=sri-lakshmi,ganesh-gold -f seeds/backfill_hsn_codes.sql 2>&1) || { echo "FAIL  HB backfill run 1: $r1"; LOG_FAIL=1; }
r2=$(psql -h localhost -U app_rw -d "$DB" -X -q -v ON_ERROR_STOP=1 -v slugs=sri-lakshmi,ganesh-gold -f seeds/backfill_hsn_codes.sql 2>&1) || { echo "FAIL  HB backfill run 2: $r2"; LOG_FAIL=1; }
if echo "$r1" | grep -q 'hsn backfill sri-lakshmi: 10 inserted' && echo "$r1" | grep -q 'hsn backfill ganesh-gold: 0 inserted' \
   && echo "$r2" | grep -q 'hsn backfill sri-lakshmi: 0 inserted' && echo "$r2" | grep -q 'hsn backfill ganesh-gold: 0 inserted'; then
  echo "PASS  HB1 backfill fills an existing tenant (10 missing codes; 7113/7114 already there) and skips a provisioned one"
  echo "PASS  HB2 second backfill run inserts nothing (ON CONFLICT DO NOTHING)"
else echo "FAIL  HB backfill output: $r1 / $r2"; LOG_FAIL=1; fi
out=$(psql -h localhost -U app_rw -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -c "SET app.tenant_id='00000000-0000-0000-0000-000000000001'" \
      -c "SELECT count(*) || '/' || count(*) FILTER (WHERE (code_type, code) IN (SELECT code_type, code FROM platform.hsn_code_default)) FROM masters.hsn_code" \
      -c "SET app.tenant_id='00000000-0000-0000-0000-000000000002'" -c "SELECT count(*) FROM masters.hsn_code" 2>&1)
if [ "$(echo "$out" | tr '\n' ' ')" = "12/12 0 " ]; then echo "PASS  HB3 tenant 1 sees exactly its 12 codes (not the provisioned tenant's); tenant 2 (not backfilled) sees 0"
else echo "FAIL  HB3 isolation: $out"; LOG_FAIL=1; fi
r3=$(psql -h localhost -U app_rw -d "$DB" -X -q -v ON_ERROR_STOP=1 -v slugs=no-such-shop -f seeds/backfill_hsn_codes.sql 2>&1) && { echo "FAIL  HB4 unknown slug accepted"; LOG_FAIL=1; } \
  || { echo "$r3" | grep -q 'unknown tenant slug' && echo "PASS  HB4 unknown slug aborts the backfill" || { echo "FAIL  HB4: $r3"; LOG_FAIL=1; }; }
echo '--- 985 demo rates seed (seeds/demo_todays_rates.sql as app_rw = dev_seed privileges)'
d1=$(psql -h localhost -U app_rw -d "$DB" -X -q -v ON_ERROR_STOP=1 -v slugs=sri-lakshmi -f seeds/demo_todays_rates.sql 2>&1) || { echo "FAIL  DR run 1: $d1"; LOG_FAIL=1; }
d2=$(psql -h localhost -U app_rw -d "$DB" -X -q -v ON_ERROR_STOP=1 -v slugs=sri-lakshmi -f seeds/demo_todays_rates.sql 2>&1) || { echo "FAIL  DR run 2: $d2"; LOG_FAIL=1; }
dv=$(psql -h localhost -U app_rw -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -c "SET app.tenant_id='00000000-0000-0000-0000-000000000001'" \
     -c "SELECT bool_and(todays_rate_set AND old_metal_rate_set) || '/' || (SELECT count(*) FROM rates.metal_rate WHERE source = 'demo_seed' AND kind = 'old_metal' AND branch_id IS NULL) FROM rates.v_todays_rate_status" 2>&1)
if echo "$d1" | grep -q 'demo rates sri-lakshmi: 1 inserted' && echo "$d2" | grep -q 'demo rates sri-lakshmi: 0 inserted' && [ "$dv" = "true/1" ]; then
  echo "PASS  DR1 seed fills only the missing shop-wide rate (SILVER 925 old_metal), keeps existing GOLD rates; every branch fully set"
  echo "PASS  DR2 second seed run inserts nothing (idempotent)"
else echo "FAIL  DR seed: $d1 / $d2 / $dv"; LOG_FAIL=1; fi
d3=$(psql -h localhost -U app_rw -d "$DB" -X -q -v ON_ERROR_STOP=1 -v slugs=no-such-shop -f seeds/demo_todays_rates.sql 2>&1) && { echo "FAIL  DR3 unknown slug accepted"; LOG_FAIL=1; } \
  || { echo "$d3" | grep -q 'unknown tenant slug' && echo "PASS  DR3 unknown slug aborts the seed" || { echo "FAIL  DR3: $d3"; LOG_FAIL=1; }; }
echo '--- 987–989 NOT VALID pre-check (seeds/check_inventory_not_valid.sql as app_rw = dev_seed privileges, read-only)'
NV_SLUGS=sri-lakshmi,other-shop,ganesh-gold
nv_run() { psql -h localhost -U app_rw -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -v slugs="$1" -f seeds/check_inventory_not_valid.sql 2>&1; }
nv_zero="inventory.lot_line.lot_line_tagged_check|0 inventory.stock_take.stock_take_closed_chk|0 inventory.stock_transfer.stock_transfer_approved_by_fk|0 inventory.stock_transfer.stock_transfer_approved_chk|0 inventory.stock_transfer.stock_transfer_cancelled_chk|0 inventory.stock_transfer.stock_transfer_dispatched_chk|0 inventory.stock_transfer.stock_transfer_received_after_dispatch|0 inventory.stock_transfer.stock_transfer_received_by_fk|0 inventory.stock_transfer.stock_transfer_received_chk|0 inventory.stock_transfer.stock_transfer_requested_by_fk|0 inventory.stock_transfer_line.stock_transfer_line_received_chk|0 inventory.stock_transfer_line.stock_transfer_line_what|0 inventory.tag.tag_pieces_check|0 inventory.tag.tag_stone_le_gross|0"
nv1=$(nv_run "$NV_SLUGS")
nv1_rows=$(echo "$nv1" | grep '|' | tr '\n' ' ' | sed 's/ $//')
if [ "$nv1_rows" = "$nv_zero" ]; then echo "PASS  NV1 clean data: one row per NOT VALID constraint (14), all 0 violations"
else echo "FAIL  NV1 clean run: $nv1"; LOG_FAIL=1; fi
nv_names=$(echo "$nv1" | grep '|' | cut -d'|' -f1 | tr '\n' ' ' | sed 's/ $//')
# 999 validated all 14 (INF-1): the report must cover exactly those 14, now convalidated, and no inventory NOT VALID remains
nv_cat=$(psql -h localhost -U app_migrator -d "$DB" -X -At -c "SELECT string_agg(c.conrelid::regclass::text || '.' || c.conname, ' ' ORDER BY c.conrelid::regclass::text || '.' || c.conname)
         FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid WHERE r.relnamespace = 'inventory'::regnamespace AND c.convalidated
          AND c.conrelid::regclass::text || '.' || c.conname = ANY (string_to_array('$nv_names', ' '))" 2>&1)
nv_left=$(psql -h localhost -U app_migrator -d "$DB" -X -At -c "SELECT count(*) FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid WHERE r.relnamespace = 'inventory'::regnamespace AND NOT c.convalidated" 2>&1)
if [ -n "$nv_cat" ] && [ "$nv_cat" = "$nv_names" ] && [ "$nv_left" = 0 ]; then echo "PASS  NV2 the check covers exactly the 14 inventory constraints 999 validated (catalog = report); 0 inventory NOT VALID left"
else echo "FAIL  NV2 catalog [$nv_cat] vs report [$nv_names], NOT VALID left $nv_left"; LOG_FAIL=1; fi
# inject one violating row per constraint family (owner drops the check, writes the row, re-adds it NOT VALID: same definition)
inj=$(psql -h localhost -U app_migrator -d "$DB" -X -q -v ON_ERROR_STOP=1 2>&1 <<'SQL'
SET app.tenant_id = '00000000-0000-0000-0000-000000000001';
BEGIN;
ALTER TABLE inventory.tag DROP CONSTRAINT tag_pieces_check, DROP CONSTRAINT tag_stone_le_gross;
UPDATE inventory.tag SET pieces = 0 WHERE id = '00000000-0000-0000-0000-00000098f011';
UPDATE inventory.tag SET stone_wt = gross_wt + 1 WHERE id = '00000000-0000-0000-0000-00000098f012';
ALTER TABLE inventory.tag ADD CONSTRAINT tag_pieces_check CHECK (pieces >= 1) NOT VALID,
                          ADD CONSTRAINT tag_stone_le_gross CHECK (stone_wt <= gross_wt) NOT VALID;
ALTER TABLE inventory.lot_line DROP CONSTRAINT lot_line_tagged_check;
UPDATE inventory.lot_line SET tagged_pieces = -1 WHERE id = '00000000-0000-0000-0000-0000009870b1';
ALTER TABLE inventory.lot_line ADD CONSTRAINT lot_line_tagged_check CHECK (tagged_pieces >= 0) NOT VALID;
ALTER TABLE inventory.stock_transfer DROP CONSTRAINT stock_transfer_approved_chk, DROP CONSTRAINT stock_transfer_requested_by_fk;
UPDATE inventory.stock_transfer SET approved_by = NULL, requested_by = '00000000-0000-0000-0000-00000000dead' WHERE id = '00000000-0000-0000-0000-0000009870d1';
ALTER TABLE inventory.stock_transfer
  ADD CONSTRAINT stock_transfer_approved_chk CHECK (status IN ('draft','cancelled') OR approved_by IS NOT NULL) NOT VALID,
  ADD CONSTRAINT stock_transfer_requested_by_fk FOREIGN KEY (tenant_id, requested_by) REFERENCES platform.app_user(tenant_id, id) NOT VALID;
ALTER TABLE inventory.stock_transfer_line DROP CONSTRAINT stock_transfer_line_what;
UPDATE inventory.stock_transfer_line SET tag_id = NULL, item_id = NULL WHERE id = '00000000-0000-0000-0000-0000009870d2';
ALTER TABLE inventory.stock_transfer_line ADD CONSTRAINT stock_transfer_line_what CHECK (tag_id IS NOT NULL OR (item_id IS NOT NULL AND purity_id IS NOT NULL)) NOT VALID;
ALTER TABLE inventory.stock_take DROP CONSTRAINT stock_take_closed_chk;
UPDATE inventory.stock_take SET closed_at = NULL WHERE id = '00000000-0000-0000-0000-0000009870e1';
ALTER TABLE inventory.stock_take ADD CONSTRAINT stock_take_closed_chk CHECK (status = 'open' OR closed_at IS NOT NULL) NOT VALID;
COMMIT;
SQL
) || { echo "FAIL  NV3 fixture injection: $inj"; LOG_FAIL=1; }
nv3=$(nv_run "$NV_SLUGS")
nv_bad="inventory.lot_line.lot_line_tagged_check|1 inventory.stock_take.stock_take_closed_chk|1 inventory.stock_transfer.stock_transfer_approved_by_fk|0 inventory.stock_transfer.stock_transfer_approved_chk|1 inventory.stock_transfer.stock_transfer_cancelled_chk|0 inventory.stock_transfer.stock_transfer_dispatched_chk|0 inventory.stock_transfer.stock_transfer_received_after_dispatch|0 inventory.stock_transfer.stock_transfer_received_by_fk|0 inventory.stock_transfer.stock_transfer_received_chk|0 inventory.stock_transfer.stock_transfer_requested_by_fk|1 inventory.stock_transfer_line.stock_transfer_line_received_chk|0 inventory.stock_transfer_line.stock_transfer_line_what|1 inventory.tag.tag_pieces_check|1 inventory.tag.tag_stone_le_gross|1"
if [ "$(echo "$nv3" | grep '|' | tr '\n' ' ' | sed 's/ $//')" = "$nv_bad" ] && echo "$nv3" | grep -q 'not-valid check sri-lakshmi: 7 violating' && echo "$nv3" | grep -q 'not-valid check other-shop: 0 violating'; then
  echo "PASS  NV3 violating fixtures: each of the 7 bad rows counted against its constraint, others 0, other shops 0"
else echo "FAIL  NV3 violating run: $nv3"; LOG_FAIL=1; fi
nv_still=$(psql -h localhost -U app_migrator -d "$DB" -X -At -c "SELECT count(*) FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid WHERE r.relnamespace = 'inventory'::regnamespace AND NOT c.convalidated" 2>&1)
if [ "$nv_still" = 7 ] && grep -q '^BEGIN READ ONLY;$' seeds/check_inventory_not_valid.sql && [ "$(grep -c '^ROLLBACK;$' seeds/check_inventory_not_valid.sql)" = 1 ] \
   && ! grep -v '^ *--' seeds/check_inventory_not_valid.sql | grep -qiE 'validate|insert |update |delete |alter |truncate|commit'; then
  echo "PASS  NV4 check is read-only (BEGIN READ ONLY … ROLLBACK, no VALIDATE/DML/DDL); the 7 constraints NV3 re-added NOT VALID are still NOT VALID after it ran"
else echo "FAIL  NV4 read-only/validate guard ($nv_still)"; LOG_FAIL=1; fi
fix=$(psql -h localhost -U app_migrator -d "$DB" -X -q -v ON_ERROR_STOP=1 2>&1 <<'SQL'
SET app.tenant_id = '00000000-0000-0000-0000-000000000001';
BEGIN;
UPDATE inventory.tag SET pieces = 1 WHERE id = '00000000-0000-0000-0000-00000098f011';
UPDATE inventory.tag SET stone_wt = 0 WHERE id = '00000000-0000-0000-0000-00000098f012';
UPDATE inventory.lot_line SET tagged_pieces = 0 WHERE id = '00000000-0000-0000-0000-0000009870b1';
UPDATE inventory.stock_transfer SET approved_by = '00000000-0000-0000-0000-000000000a01', requested_by = '00000000-0000-0000-0000-000000000a02' WHERE id = '00000000-0000-0000-0000-0000009870d1';
UPDATE inventory.stock_transfer_line SET tag_id = '00000000-0000-0000-0000-00000098f005' WHERE id = '00000000-0000-0000-0000-0000009870d2';
UPDATE inventory.stock_take SET closed_at = now() WHERE id = '00000000-0000-0000-0000-0000009870e1';
COMMIT;
SQL
) || { echo "FAIL  NV5 fixture repair: $fix"; LOG_FAIL=1; }
nv5=$(nv_run "$NV_SLUGS")
nv6=$(nv_run no-such-shop) && { echo "FAIL  NV5 unknown slug accepted"; LOG_FAIL=1; }
if [ "$(echo "$nv5" | grep '|' | tr '\n' ' ' | sed 's/ $//')" = "$nv_zero" ] && echo "$nv6" | grep -q 'unknown tenant slug'; then
  echo "PASS  NV5 after repairing the rows every count is back to 0; unknown slug aborts the check"
else echo "FAIL  NV5: $nv5 / $nv6"; LOG_FAIL=1; fi
pdh=$(psql -h localhost -U app_rw -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -v slugs=sri-lakshmi -f seeds/check_inventory_not_valid_predeploy.sql 2>&1) \
  && { echo "FAIL  PD4 pre-deploy variant ran on a 987+ DB"; LOG_FAIL=1; } \
  || { echo "$pdh" | grep -q 'not at the 000–986 state' && echo "PASS  PD4 pre-deploy variant refuses a DB that already has 987–989 (points to check_inventory_not_valid.sql)" || { echo "FAIL  PD4: $pdh"; LOG_FAIL=1; }; }
spdh=$(psql -h localhost -U app_rw -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -v slugs=sri-lakshmi -f seeds/check_sales_not_valid_predeploy.sql 2>&1) \
  && { echo "FAIL  SPD4 sales pre-check ran on a 991+ DB"; LOG_FAIL=1; } \
  || { echo "$spdh" | grep -q 'not at the 000–990 state' && echo "PASS  SPD4 sales pre-check refuses a DB that already has 991+" || { echo "FAIL  SPD4: $spdh"; LOG_FAIL=1; }; }
if grep -q '^BEGIN READ ONLY;$' seeds/check_sales_not_valid_predeploy.sql && [ "$(grep -c '^ROLLBACK;$' seeds/check_sales_not_valid_predeploy.sql)" = 1 ] \
   && grep -q '^SET default_transaction_read_only = on;$' seeds/check_sales_not_valid_predeploy.sql \
   && ! grep -v '^ *--' seeds/check_sales_not_valid_predeploy.sql | grep -qiE 'validate|insert |update |delete |alter |truncate|commit|create |drop '; then
  echo "PASS  SPD5 sales pre-check is read-only by construction (read-only default + BEGIN READ ONLY … ROLLBACK, no write / DDL / VALIDATE)"
else echo "FAIL  SPD5 sales pre-check contains a write keyword"; LOG_FAIL=1; fi
# VS1–VS5: seeds/validate_sales_constraints.sql (Wheeljack runs it after the Sales migrate; superuser login, VALIDATE as app_migrator)
vs_nv() { sudo -u postgres psql -d "$DB" -X -At -c "SELECT string_agg(conname || ':' || convalidated, ',' ORDER BY conname) || '|' || (SELECT count(*) FROM pg_constraint WHERE NOT convalidated AND connamespace = 'sales'::regnamespace)
  FROM pg_constraint WHERE connamespace = 'sales'::regnamespace AND conname IN ('invoice_line_stock_check','invoice_old_metal_required_check')"; }
vs_before=$(vs_nv)
vs1=$(psql -h localhost -U app_migrator -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -f seeds/validate_sales_constraints.sql 2>&1); vs1_rc=$?
if [ $vs1_rc -ne 0 ] && echo "$vs1" | grep -q 'run as the Postgres superuser' && [ "$(vs_nv)" = "$vs_before" ]; then
  echo "PASS  VS1 validate seed refuses a non-superuser (app_migrator cannot count other tenants' rows through forced RLS), nothing validated"
else echo "FAIL  VS1 validate seed as app_migrator: rc=$vs1_rc $vs1"; LOG_FAIL=1; fi
# VS2: one violating legacy-shaped goods line made in an uncommitted transaction (constraint dropped + re-added NOT VALID); the seed must abort
vs2=$( { cat <<'SQL'
\set ON_ERROR_STOP 1
BEGIN;
SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'sales.invoice_line'::regclass AND conname = 'invoice_line_stock_check' \gset
SET LOCAL SESSION AUTHORIZATION app_migrator;
ALTER TABLE sales.invoice_line DROP CONSTRAINT invoice_line_stock_check;
RESET SESSION AUTHORIZATION;
SET LOCAL session_replication_role = replica;
UPDATE sales.invoice_line SET stock_kind = NULL WHERE id = (SELECT id FROM sales.invoice_line WHERE line_kind = 'goods' ORDER BY id LIMIT 1);
SET LOCAL session_replication_role = origin;
SET LOCAL SESSION AUTHORIZATION app_migrator;
ALTER TABLE sales.invoice_line ADD CONSTRAINT invoice_line_stock_check :d NOT VALID;
RESET SESSION AUTHORIZATION;
SQL
  cat seeds/validate_sales_constraints.sql; } | sudo -u postgres psql -d "$DB" -X -q -At 2>&1); vs2_rc=$?
if [ $vs2_rc -ne 0 ] && echo "$vs2" | grep -q 'violating rows: sales.invoice_line.invoice_line_stock_check=1 .*nothing validated' \
   && ! echo "$vs2" | grep -q '^validated|'; then
  echo "PASS  VS2 validate seed counts first and aborts on 1 violating row (invoice_line_stock_check=1), nothing validated"
else echo "FAIL  VS2 validate seed with a violating row: rc=$vs2_rc $vs2"; LOG_FAIL=1; fi
if [ "$(vs_nv)" = "$vs_before" ] && [ "$(sudo -u postgres psql -d "$DB" -At -c "SELECT count(*) FROM sales.invoice_line WHERE line_kind = 'goods' AND stock_kind IS NULL")" = 0 ]; then
  echo "PASS  VS3 aborted run left nothing behind (catalogue validation flags unchanged, $(echo "$vs_before" | cut -d'|' -f2) NOT VALID in sales, no NULL stock_kind goods line)"
else echo "FAIL  VS3 after abort: $(vs_nv)"; LOG_FAIL=1; fi
vs4=$(sudo -u postgres psql -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -f seeds/validate_sales_constraints.sql 2>&1); vs4_rc=$?
if [ $vs4_rc -eq 0 ] && [ "$(vs_nv)" = "invoice_line_stock_check:true,invoice_old_metal_required_check:true|0" ] \
   && echo "$vs4" | grep -q '^still_not_valid|0$' \
   && [ "$(sudo -u postgres psql -d "$DB" -At -c "SELECT count(*) FROM public.schema_change_log WHERE session_user_name = 'app_migrator' AND command_tag = 'ALTER TABLE' AND object_identity IN ('sales.invoice_line','sales.invoice_old_metal') AND occurred_at > now() - interval '5 minutes'")" -ge 2 ]; then
  echo "PASS  VS4 validate seed (superuser, VALIDATE as app_migrator, logged): both constraints already VALID; all 19 certified by 999"
else echo "FAIL  VS4 validate seed: rc=$vs4_rc $(vs_nv) $vs4"; LOG_FAIL=1; fi
vs5=$(sudo -u postgres psql -d "$DB" -X -q -At -v ON_ERROR_STOP=1 -f seeds/validate_sales_constraints.sql 2>&1); vs5_rc=$?
if [ $vs5_rc -eq 0 ] && [ "$(vs_nv)" = "invoice_line_stock_check:true,invoice_old_metal_required_check:true|0" ]; then
  echo "PASS  VS5 re-running the validate seed is a no-op"
else echo "FAIL  VS5 re-run: rc=$vs5_rc $vs5"; LOG_FAIL=1; fi
if grep -iqE '^[^-]*\b(insert|update|delete|truncate|drop|create)\b' seeds/validate_sales_constraints.sql \
   || [ "$(grep -v '^ *--' seeds/validate_sales_constraints.sql | grep -ciE 'validate constraint')" != 2 ]; then
  echo "FAIL  VS6 validate seed must contain only the 2 VALIDATEs (no other DDL / writes)"; LOG_FAIL=1
else echo "PASS  VS6 validate seed contains exactly 2 VALIDATE CONSTRAINT statements and no other DDL / writes"; fi
# AT1/AT2: outbox alert CHECKs widened by 995 still reject unknown types / topics (superuser insert, rolled back)
at_try() { sudo -u postgres psql -d "$DB" -X -q -At -c "BEGIN; INSERT INTO notifications.outbox(tenant_id, topic, payload, ref_type, ref_id, alert_type)
  VALUES ('00000000-0000-0000-0000-000000000001', '$1', '{}', 'credit_note', gen_random_uuid(), '$2'); ROLLBACK;" 2>&1; }
at1=$(at_try alert.receipt_reversal payment_bounced)
if echo "$at1" | grep -q 'outbox_alert_type_check'; then echo "PASS  AT1 outbox alert_type CHECK rejects an unknown type (payment_bounced)"
else echo "FAIL  AT1 unknown alert_type: $at1"; LOG_FAIL=1; fi
at2=$(at_try alert.payment_bounced receipt_reversal)
if echo "$at2" | grep -q 'outbox_alert_topic_check'; then echo "PASS  AT2 outbox topic CHECK rejects an unknown alert topic with an alert_type"
else echo "FAIL  AT2 unknown alert topic: $at2"; LOG_FAIL=1; fi
at3=$(at_try alert.receipt_reversal receipt_reversal)
if [ -z "$at3" ] && [ "$(sudo -u postgres psql -d "$DB" -At -c "SELECT count(*) FROM notifications.outbox WHERE alert_type = 'receipt_reversal' AND payload = '{}'")" = 0 ]; then
  echo "PASS  AT3 receipt_reversal / alert.receipt_reversal accepted by both CHECKs (rolled back)"
else echo "FAIL  AT3 receipt_reversal alert: $at3"; LOG_FAIL=1; fi
echo '--- app_ro: can SELECT every table in every module schema, cannot write'
PGOPTIONS='-c app.tenant_id=00000000-0000-0000-0000-000000000001' psql -h localhost -U app_ro -d "$DB" -At -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r record; n int := 0; bad text[] := '{}';
BEGIN
  FOR r IN SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN
      ('platform','billing','notifications','masters','rates','hr','accounts','inventory','approvals','sales','orders','purchases','refinery','branding')
      AND (schemaname, tablename) NOT IN (('platform','platform_admin'),('platform','platform_admin_session'),   -- admin console only
          ('platform','partner_user'),('platform','partner_session'),          -- partner credentials
          ('platform','otp_challenge'),('platform','otp_delivery'),('platform','user_session'),         -- OTP hashes / ciphertext
          ('platform','rate_limit_bucket'),                                   -- login counters
          ('platform','idempotency_key'),                                      -- stored API responses (973)
          ('masters','kyc_document_secret'))                                  -- KYC number ciphertext (979)
  LOOP
    BEGIN EXECUTE format('SELECT 1 FROM %I.%I LIMIT 1', r.schemaname, r.tablename); n := n + 1;
    EXCEPTION WHEN insufficient_privilege THEN bad := bad || (r.schemaname || '.' || r.tablename); END;
  END LOOP;
  FOR r IN SELECT viewname FROM pg_views WHERE schemaname = 'reports' LOOP
    EXECUTE format('SELECT 1 FROM reports.%I LIMIT 1', r.viewname); n := n + 1;
  END LOOP;
  IF cardinality(bad) > 0 THEN RAISE EXCEPTION 'FAIL  app_ro cannot read: %', bad; END IF;
  IF NOT has_table_privilege('app_ro', 'masters.customer_group', 'SELECT') THEN RAISE EXCEPTION 'FAIL customer_group'; END IF;
  RAISE NOTICE 'PASS  app_ro can SELECT all % tables/views (incl. every masters table)', n;
  BEGIN
    INSERT INTO masters.customer_group(tenant_id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'x');
    RAISE EXCEPTION 'FAIL  app_ro was able to INSERT';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS  app_ro INSERT correctly denied (%)', SQLERRM;
  END;
END $$;
DO $$
DECLARE p text; parts text[]; n int := 0; leaks text[] := '{}';
BEGIN
  FOREACH p IN ARRAY ARRAY['platform.app_user.password_hash','platform.app_user.mfa_secret_enc','platform.partner_user.password_hash',
                     'platform.platform_admin.password_hash','platform.platform_admin.mfa_secret_enc',
                     'platform.otp_challenge.code_hash','platform.otp_delivery.ciphertext',
                     'platform.user_session.token_hash','platform.partner_session.token_hash','platform.platform_admin_session.token_hash',
                     'platform.rate_limit_bucket.bucket_key','platform.rate_limit_bucket.locked_until',
                     'masters.customer.pan_enc','masters.customer.pan_key_id','hr.staff.pan_enc','hr.staff.pan_key_id','masters.vendor.pan_enc','masters.vendor.pan_key_id','masters.vendor.pan','masters.kyc_document_secret.number_enc','masters.kyc_document_secret.number_key_id',
                     'masters.bank_account.account_no_enc','masters.bank_account.account_key_id','branding.custom_domain.verification_token'] LOOP
    parts := string_to_array(p, '.');
    BEGIN
      EXECUTE format('SELECT %I FROM %I.%I LIMIT 1', parts[3], parts[1], parts[2]);
      leaks := leaks || p;
    EXCEPTION WHEN insufficient_privilege THEN n := n + 1;
    END;
  END LOOP;
  IF cardinality(leaks) > 0 THEN RAISE EXCEPTION 'FAIL  app_ro can read secrets: %', leaks; END IF;
  RAISE NOTICE 'PASS  L6 app_ro denied all % secret columns (creds, OTP, sessions, rate limits, PAN, bank, DNS token)', n;
  PERFORM id, name, pan_last4 FROM masters.customer LIMIT 1;
  PERFORM id, name, username FROM platform.app_user LIMIT 1;
  RAISE NOTICE 'PASS  L7 app_ro still reads customer name/pan_last4 and user names for reports';
  PERFORM bank_name, branch_name, ifsc, holder_name, account_last4 FROM masters.bank_account;
  RAISE NOTICE 'PASS  B11 app_ro reads bank name/IFSC/holder/last4 (not the account ciphertext)';
END $$;
SQL
}
main 2>&1 | tee "$LOG"
P=$(grep -cE '(^| )PASS ' "$LOG"); F=$(grep -E '(^| )FAIL|ERROR:|failed:|^psql:[^ ]*: error:' "$LOG" | grep -vc 'PASS ')   # psql client errors (bad \gset, missing file) abort a file too
# the only expected ERROR-free failures are none; app_ro denial is reported via NOTICE PASS
SUMMARY="SUMMARY: $P passed, $F failed — $(TZ=Asia/Kolkata date '+%Y-%m-%d %H:%M IST') — PostgreSQL $(sudo -u postgres psql -At -c 'show server_version')"
echo "$SUMMARY" | tee -a "$LOG"
[ "$F" -eq 0 ]
