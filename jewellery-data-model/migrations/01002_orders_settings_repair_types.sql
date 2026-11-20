-- 01002 Orders O12 (settings) and O13 (repair types under Masters).
-- O12: one settings row per shop (no row = the defaults below), written only by orders_writer.
CREATE TABLE orders.shop_setting (
  tenant_id uuid NOT NULL REFERENCES platform.tenant(id),
  id uuid NOT NULL DEFAULT platform.uuid_v7(),
  -- tokens {BRANCH} {FY} {SEQ:n}; rendered when the document is created and stored, so a change affects new documents only
  order_no_format  text NOT NULL DEFAULT 'ORD-{BRANCH}-{FY}-{SEQ:5}' CONSTRAINT shop_setting_order_no_format_check
                   CHECK (char_length(order_no_format) BETWEEN 1 AND 64 AND order_no_format ~ '\{SEQ(:[1-9][0-9]?)?\}'),
  repair_no_format text NOT NULL DEFAULT 'REP-{BRANCH}-{FY}-{SEQ:5}' CONSTRAINT shop_setting_repair_no_format_check
                   CHECK (char_length(repair_no_format) BETWEEN 1 AND 64 AND repair_no_format ~ '\{SEQ(:[1-9][0-9]?)?\}'),
  default_due_days smallint CONSTRAINT shop_setting_default_due_days_check CHECK (default_due_days BETWEEN 1 AND 365),   -- NULL = no default due date
  -- repair: weight lost at the workshop, as % of the weight issued; more than this BLOCKS the receipt (override: orders.repair.loss_override)
  repair_loss_tolerance_pct numeric(5,2) NOT NULL DEFAULT 1.00 CONSTRAINT shop_setting_loss_tolerance_check CHECK (repair_loss_tolerance_pct BETWEEN 0 AND 100),
  advance_required boolean NOT NULL DEFAULT false,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  CONSTRAINT shop_setting_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT shop_setting_one_per_shop UNIQUE (tenant_id),
  CONSTRAINT shop_setting_updated_by_fk FOREIGN KEY (tenant_id, updated_by) REFERENCES platform.app_user(tenant_id, id)
);
COMMENT ON TABLE orders.shop_setting IS 'Orders and repairs settings, one row per shop (no row = defaults). Changed only with orders.settings.manage; enforced by the app.';
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON orders.shop_setting FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
SELECT platform.enable_audit('orders.shop_setting');
ALTER TABLE orders.shop_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders.shop_setting FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON orders.shop_setting USING (tenant_id = platform.current_tenant()) WITH CHECK (tenant_id = platform.current_tenant());
CREATE POLICY no_partner_access ON orders.shop_setting AS RESTRICTIVE USING (platform.current_partner() IS NULL) WITH CHECK (platform.current_partner() IS NULL);
REVOKE ALL ON orders.shop_setting FROM PUBLIC, app_rw, app_ro, app_worker;
GRANT SELECT ON orders.shop_setting TO app_rw, app_ro;
GRANT SELECT, INSERT, UPDATE ON orders.shop_setting TO orders_writer;    -- no DELETE

-- O13: repair types become a normal versioned Masters list (/v1/masters/repair-types).
ALTER TABLE masters.repair_type
  ADD COLUMN is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN version int NOT NULL DEFAULT 1,
  ADD CONSTRAINT repair_type_customer_range CHECK (min_customer_charge IS NULL OR max_customer_charge IS NULL OR min_customer_charge <= max_customer_charge),
  ADD CONSTRAINT repair_type_vendor_range CHECK (min_vendor_charge IS NULL OR max_vendor_charge IS NULL OR min_vendor_charge <= max_vendor_charge);
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON masters.repair_type FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
SELECT platform.enable_audit('masters.repair_type');
INSERT INTO platform.permission(code, module, description) VALUES
 ('masters.repair_types.view',   'masters', 'View repair types'),
 ('masters.repair_types.manage', 'masters', 'Manage repair types');
INSERT INTO platform.system_role_permission(role_code, permission_code)
SELECT r.code, p.code FROM platform.permission p
CROSS JOIN (VALUES ('owner'), ('manager'), ('salesperson'), ('cashier')) AS r(code)
WHERE p.code IN ('masters.repair_types.view', 'masters.repair_types.manage') AND (r.code IN ('owner','manager') OR p.code LIKE '%.view');
