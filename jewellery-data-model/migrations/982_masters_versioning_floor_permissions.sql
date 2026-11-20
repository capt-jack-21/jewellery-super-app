-- 982_masters_versioning_floor_permissions.sql — remaining Masters needs (Ironhide, 2026-10-28).
-- Already covered by 976–981, not repeated: version/aa_version + is_active on stone_standard, diamond_rate (977),
-- value_addition_rule + mc_percent (978), customer, vendor(version), hr.staff (979), counter, box (980).
-- Here: item, sub_item, floor versioning/is_active; floor.code; masters.* permissions; old_gold payment mode.

-- 1/2. version + aa_version (+ is_active where missing; item already has is_active)
ALTER TABLE masters.item     ADD COLUMN version int NOT NULL DEFAULT 1;
ALTER TABLE masters.sub_item ADD COLUMN is_active boolean NOT NULL DEFAULT true,
                             ADD COLUMN version int NOT NULL DEFAULT 1;
-- 5. floor.code: nullable so existing floors stay valid; unique per (tenant, branch) like masters.counter
ALTER TABLE masters.floor    ADD COLUMN code varchar(10) CHECK (code ~ '^[A-Za-z0-9_-]{1,10}$'),
                             ADD COLUMN is_active boolean NOT NULL DEFAULT true,
                             ADD COLUMN version int NOT NULL DEFAULT 1,
                             ADD CONSTRAINT floor_branch_code_uq UNIQUE (tenant_id, branch_id, code);
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON masters.item     FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON masters.sub_item FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON masters.floor    FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
SELECT platform.enable_audit('masters.item');
SELECT platform.enable_audit('masters.sub_item');
SELECT platform.enable_audit('masters.floor');

-- 9. masters.* permissions (global catalogue). Tenant roles reference system_role_code, so every existing and
-- future tenant's system roles get these through platform.system_role_permission; no per-tenant rows exist to backfill.
INSERT INTO platform.permission(code, module, description)
SELECT 'masters.' || a.area || '.' || v.verb, 'masters', initcap(v.verb) || ' ' || a.label
FROM (VALUES ('metals','metals and purities'), ('items','item categories and sub-items'), ('designs','products/designs and photos'),
             ('stones','stones and stone rates'), ('making_rules','making-charge and wastage rules'), ('customers','customers and KYC'),
             ('vendors','suppliers and karigars'), ('staff','staff and salespeople'), ('counters','floors, counters and trays'),
             ('tax','HSN codes'), ('payments','payment modes, banks and card machines')) AS a(area, label),
     (VALUES ('view'), ('manage')) AS v(verb);
INSERT INTO platform.system_role_permission(role_code, permission_code)
SELECT r.code, p.code FROM platform.permission p
CROSS JOIN (VALUES ('owner'), ('manager'), ('salesperson'), ('cashier')) AS r(code)
WHERE p.module = 'masters' AND (r.code IN ('owner','manager') OR p.code LIKE '%.view');

-- 10. old-gold exchange as a tender on the bill
ALTER TABLE sales.invoice_payment DROP CONSTRAINT invoice_payment_mode_check;
ALTER TABLE sales.invoice_payment ADD CONSTRAINT invoice_payment_mode_check CHECK (mode IN ('cash','upi','debit_card','credit_card','bank_transfer','cheque',
  'gift_voucher','advance','chit','credit_note','old_gold'));
