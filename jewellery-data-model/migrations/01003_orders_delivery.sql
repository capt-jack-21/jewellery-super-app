-- O6: deliver and bill an order through Sales (Sales minor release; deploys with Orders in one release).
--   1. orders.shop_setting.rate_rule: which rate an order bill uses when the order has a locked rate
--        'locked'   = always the locked rate (default)
--        'lower_of' = the lower of the locked rate and today's rate
--   2. sales.invoice.order_id: the order a bill delivers (NULL for ordinary bills). Written only by the Sales issue path (sales_writer).
-- No data is changed; both columns are additive and nullable / defaulted.

ALTER TABLE orders.shop_setting ADD COLUMN rate_rule text NOT NULL DEFAULT 'locked' CHECK (rate_rule IN ('locked', 'lower_of'));

ALTER TABLE sales.invoice ADD COLUMN order_id uuid;
ALTER TABLE sales.invoice ADD CONSTRAINT invoice_order_fk FOREIGN KEY (tenant_id, order_id) REFERENCES orders.customer_order(tenant_id, id);
CREATE UNIQUE INDEX invoice_one_live_bill_per_order ON sales.invoice(tenant_id, order_id) WHERE order_id IS NOT NULL AND status <> 'cancelled';

-- sales_writer's INSERT on sales.invoice is column-level (992: row_rev is never writable), so the new column needs its own grant.
GRANT INSERT (order_id) ON sales.invoice TO sales_writer;
