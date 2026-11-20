-- 985_rates_scope.sql — rates scope (frozen 2026-10-28): only the gaps left after 000–984.
-- Reused unchanged: rates.metal_rate (R1 sale rate per purity per day, R3 branch_id NULL = shop-wide / branch row
-- overrides, R4 insert-only history + zz_audit, R8 kind 'old_metal'), sales.invoice.rate_snapshot +
-- invoice_line/invoice_old_metal rate_id/rate_per_g (R5), onboarding step todays_rates (R9).
-- No effective_to: a rate is in force from effective_from until a newer row (same rule as masters.tax_rule).
-- No new DB functions: purity derivation, rate lookup and the billing block stay in the app.
--  1. R2  metal_rate.derived_from_id + derived_rate_per_g: which base (24K) row a purity rate was derived from and
--         the computed value; rate_per_g <> derived_rate_per_g means it was edited.
--  2. R6  'rates.edit' (existing) is the rate-change permission; manager now gets it too (owner already has all).
--  3. R9  rates.v_todays_rate_status (per active branch: every active metal has a sale rate today, IST, shop-wide or
--         branch override; old_metal only reported); platform.v_billing_unlocked appends todays_rate_set (all branches set).
--  4. R11 branding.print_template.doc_type += 'rate_card'.
SET search_path = rates, platform, public;

-- ---------- 1. R2 derived purity rates ----------
ALTER TABLE rates.metal_rate
  ADD COLUMN derived_from_id    uuid,
  ADD COLUMN derived_rate_per_g numeric(14,2),
  ADD CONSTRAINT metal_rate_derived_from_fk FOREIGN KEY (tenant_id, derived_from_id) REFERENCES rates.metal_rate(tenant_id, id),
  ADD CONSTRAINT metal_rate_derived_chk CHECK ((derived_from_id IS NULL) = (derived_rate_per_g IS NULL) AND derived_rate_per_g > 0
                                               AND derived_from_id IS DISTINCT FROM id);

-- ---------- 2. R6 rate change ----------
INSERT INTO platform.system_role_permission(role_code, permission_code) VALUES ('manager', 'rates.edit')
ON CONFLICT DO NOTHING;

-- ---------- 3. R9 billing blocked until today's rate is set (views only) ----------
-- rates.v_todays_rate_status: one row per ACTIVE branch. A metal "the shop sells" = masters.metal.is_active with at
-- least one active purity. It is covered when some active purity of it has a rate dated today (IST) that is
-- shop-wide (branch_id NULL) or that branch's override. Sale coverage gates billing; old_metal is only reported.
-- A branch of a shop with no active metal is NOT set (nothing to price).
CREATE VIEW rates.v_todays_rate_status WITH (security_invoker = true) AS
WITH bm AS (
  SELECT b.tenant_id, b.id AS branch_id, m.code::text AS metal_code,
         EXISTS (SELECT 1 FROM rates.metal_rate r JOIN masters.purity p ON p.tenant_id = r.tenant_id AND p.id = r.purity_id
                 WHERE r.tenant_id = b.tenant_id AND p.metal_id = m.id AND p.is_active AND r.kind = 'sale'
                   AND r.rate_date = (now() AT TIME ZONE 'Asia/Kolkata')::date
                   AND (r.branch_id IS NULL OR r.branch_id = b.id)) AS sale_ok,
         EXISTS (SELECT 1 FROM rates.metal_rate r JOIN masters.purity p ON p.tenant_id = r.tenant_id AND p.id = r.purity_id
                 WHERE r.tenant_id = b.tenant_id AND p.metal_id = m.id AND p.is_active AND r.kind = 'old_metal'
                   AND r.rate_date = (now() AT TIME ZONE 'Asia/Kolkata')::date
                   AND (r.branch_id IS NULL OR r.branch_id = b.id)) AS old_ok
  FROM platform.branch b
  JOIN masters.metal m ON m.tenant_id = b.tenant_id AND m.is_active
                      AND EXISTS (SELECT 1 FROM masters.purity p WHERE p.tenant_id = m.tenant_id AND p.metal_id = m.id AND p.is_active)
  WHERE b.is_active)
SELECT b.tenant_id, b.id AS branch_id,
       count(bm.metal_code) > 0 AND coalesce(bool_and(bm.sale_ok), false)                     AS todays_rate_set,
       coalesce(array_agg(bm.metal_code ORDER BY bm.metal_code) FILTER (WHERE NOT bm.sale_ok), '{}') AS missing_metal_codes,
       count(bm.metal_code) > 0 AND coalesce(bool_and(bm.old_ok), false)                      AS old_metal_rate_set,
       coalesce(array_agg(bm.metal_code ORDER BY bm.metal_code) FILTER (WHERE NOT bm.old_ok), '{}')  AS missing_old_metal_codes
FROM platform.branch b
LEFT JOIN bm ON bm.tenant_id = b.tenant_id AND bm.branch_id = b.id
WHERE b.is_active
GROUP BY b.tenant_id, b.id;

-- platform.v_billing_unlocked: same columns, same order; todays_rate_set appended = the shop has at least one active
-- branch and every active branch is set. When false, missing_steps also lists 'todays_rates'. Per-branch detail
-- (which metals) comes from rates.v_todays_rate_status; billing a branch should check that branch's row.
CREATE OR REPLACE VIEW platform.v_billing_unlocked WITH (security_invoker = true) AS
WITH st AS (
  SELECT t.id AS tenant_id,
         coalesce(array_agg(s.code ORDER BY s.seq) FILTER (WHERE p.status IS DISTINCT FROM 'completed'), '{}') AS missing,
         bool_and(p.status IS NOT DISTINCT FROM 'completed') AS steps_done,
         EXISTS (SELECT 1 FROM rates.v_todays_rate_status v WHERE v.tenant_id = t.id)
           AND NOT EXISTS (SELECT 1 FROM rates.v_todays_rate_status v WHERE v.tenant_id = t.id AND NOT v.todays_rate_set) AS todays_rate_set
  FROM platform.tenant t
  CROSS JOIN platform.onboarding_step s
  LEFT JOIN platform.onboarding_progress p ON p.tenant_id = t.id AND p.step = s.code
  WHERE s.required_for_billing
  GROUP BY t.id)
SELECT tenant_id,
       CASE WHEN todays_rate_set OR 'todays_rates' = ANY (missing) THEN missing ELSE missing || 'todays_rates'::text END AS missing_steps,
       steps_done AND todays_rate_set AS billing_unlocked,
       todays_rate_set
FROM st;
-- grants (security_invoker: readers need the underlying tables). app_rw/app_ro + every role that reads v_billing_unlocked
-- get SELECT on the new view and on rates.metal_rate if they lack it; a role without masters.metal/purity read gets only
-- the 4 columns the view uses (platform.branch is already readable by all of them).
DO $$
DECLARE g record;
BEGIN
  FOR g IN SELECT DISTINCT a.grantee::regrole::text AS role
           FROM pg_class c, aclexplode(c.relacl) a
           WHERE c.oid = 'platform.v_billing_unlocked'::regclass AND a.privilege_type = 'SELECT' AND a.grantee NOT IN (c.relowner, 0)
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA rates TO %I', g.role);
    EXECUTE format('GRANT SELECT ON rates.v_todays_rate_status TO %I', g.role);
    IF NOT has_table_privilege(g.role, 'rates.metal_rate', 'SELECT') THEN EXECUTE format('GRANT SELECT ON rates.metal_rate TO %I', g.role); END IF;
    -- accounts_writer has no masters.metal/purity read (same as masters.item): only the columns the view uses
    IF NOT has_table_privilege(g.role, 'masters.metal', 'SELECT') THEN
      EXECUTE format('GRANT USAGE ON SCHEMA masters TO %I', g.role);
      EXECUTE format('GRANT SELECT (tenant_id, id, code, is_active) ON masters.metal TO %I', g.role);
    END IF;
    IF NOT has_table_privilege(g.role, 'masters.purity', 'SELECT') THEN
      EXECUTE format('GRANT SELECT (tenant_id, id, metal_id, is_active) ON masters.purity TO %I', g.role);
    END IF;
  END LOOP;
END $$;

-- ---------- 4. R11 printable rate card ----------
ALTER TABLE branding.print_template DROP CONSTRAINT print_template_doc_type_check;
ALTER TABLE branding.print_template ADD CONSTRAINT print_template_doc_type_check
  CHECK (doc_type IN ('invoice','estimate','tag_label','receipt','credit_note','order_receipt','rate_card'));
