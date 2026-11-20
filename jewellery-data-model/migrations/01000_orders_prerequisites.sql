-- 01000_orders_prerequisites.sql — O0 for Orders & Repairs (freeze approved 2026-11-17). First 5-digit migration.
-- Additive only: nothing here changes an existing column or an applied migration.
--   1. version column + optimistic-concurrency trigger + audit on the four orders tables
--   2. missing foreign keys (repair branch, order line item/purity, repair line vendor)
--   3. tag link on repair lines (the customer's own piece, tracked in Inventory)
--   4. fine-gram balance on sales.advance (metal advances), changeable only by sales_writer
--   5. orders.* permissions for the preset roles
SET search_path = orders, platform, public;

-- 1. version columns (N11 optimistic concurrency, same pattern as 982)
ALTER TABLE orders.customer_order ADD COLUMN version int NOT NULL DEFAULT 1;
ALTER TABLE orders.order_line     ADD COLUMN version int NOT NULL DEFAULT 1;
ALTER TABLE orders.repair         ADD COLUMN version int NOT NULL DEFAULT 1;
ALTER TABLE orders.repair_line    ADD COLUMN version int NOT NULL DEFAULT 1;
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON orders.customer_order FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON orders.order_line     FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON orders.repair         FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON orders.repair_line    FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
SELECT platform.enable_audit('orders.customer_order');
SELECT platform.enable_audit('orders.order_line');
SELECT platform.enable_audit('orders.repair');
SELECT platform.enable_audit('orders.repair_line');

-- 2. missing foreign keys (the orders tables are empty on every live tenant: no module wrote to them yet)
ALTER TABLE orders.repair      ADD CONSTRAINT repair_branch_fk      FOREIGN KEY (tenant_id, branch_id)      REFERENCES platform.branch(tenant_id, id);
ALTER TABLE orders.order_line  ADD CONSTRAINT order_line_item_fk    FOREIGN KEY (tenant_id, item_id)        REFERENCES masters.item(tenant_id, id);
ALTER TABLE orders.order_line  ADD CONSTRAINT order_line_purity_fk  FOREIGN KEY (tenant_id, purity_id)      REFERENCES masters.purity(tenant_id, id);
ALTER TABLE orders.repair_line ADD CONSTRAINT repair_line_vendor_fk FOREIGN KEY (tenant_id, vendor_id)      REFERENCES masters.vendor(tenant_id, id);

-- 3. tag link on repair lines
ALTER TABLE orders.repair_line ADD COLUMN tag_id uuid;
ALTER TABLE orders.repair_line ADD CONSTRAINT repair_line_tag_fk FOREIGN KEY (tenant_id, tag_id) REFERENCES inventory.tag(tenant_id, id);

-- 4. fine-gram balance for metal advances. `balance` stays money-only. Same rule as the money balance:
--    only the sales module role may change it (Orders asks a Sales function to do it). Redemption/refund limits
--    are added together with the Sales functions that use this column.
ALTER TABLE sales.advance ADD COLUMN balance_fine_g platform.weight_g NOT NULL DEFAULT 0;
CREATE FUNCTION sales.advance_fine_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.balance_fine_g IS DISTINCT FROM OLD.balance_fine_g AND current_user <> 'sales_writer' THEN
    RAISE EXCEPTION 'advance fine-gram balance changes only via the sales module role';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER advance_fine_guard BEFORE UPDATE ON sales.advance FOR EACH ROW EXECUTE FUNCTION sales.advance_fine_guard();

-- 5. permissions (global catalogue; system roles carry them, so every tenant gets them without backfill)
INSERT INTO platform.permission(code, module, description) VALUES
 ('orders.order.view',        'orders', 'View customer orders'),
 ('orders.order.create',      'orders', 'Create and edit customer orders'),
 ('orders.order.assign',      'orders', 'Assign order lines to a vendor'),
 ('orders.order.receive',     'orders', 'Receive a finished piece against an order'),
 ('orders.order.deliver',     'orders', 'Deliver and bill an order'),
 ('orders.order.cancel',      'orders', 'Cancel an order'),
 ('orders.advance.take',      'orders', 'Take an advance against an order or repair'),
 ('orders.repair.view',       'orders', 'View repairs'),
 ('orders.repair.create',     'orders', 'Create and edit repairs'),
 ('orders.repair.vendor',     'orders', 'Issue a repair to a vendor and receive it back'),
 ('orders.repair.deliver',    'orders', 'Deliver and bill a repair'),
 ('orders.repair.cancel',     'orders', 'Cancel a repair'),
 ('orders.repair.loss_override', 'orders', 'Accept a repair weight loss above the shop tolerance'),
 ('orders.settings.manage',   'orders', 'Manage order and repair settings');
INSERT INTO platform.system_role_permission(role_code, permission_code)
SELECT 'owner', code FROM platform.permission WHERE module = 'orders'
UNION ALL SELECT 'manager', code FROM platform.permission WHERE module = 'orders'
UNION ALL SELECT r.code, p.code FROM (VALUES ('salesperson'), ('cashier')) AS r(code)
  CROSS JOIN (VALUES ('orders.order.view'), ('orders.order.create'), ('orders.advance.take'),
                     ('orders.repair.view'), ('orders.repair.create')) AS p(code);
