-- 01006 Orders O9: a repair is billed as a service invoice. (1) the bill points at the repair; one live bill per repair.
-- (2) a service line has no item, purity, metal rate or making: those goods columns may be NULL for line_kind = 'service' only.
ALTER TABLE sales.invoice ADD COLUMN repair_id uuid;
ALTER TABLE sales.invoice ADD CONSTRAINT invoice_repair_fk FOREIGN KEY (tenant_id, repair_id) REFERENCES orders.repair(tenant_id, id);
ALTER TABLE sales.invoice ADD CONSTRAINT invoice_order_or_repair_chk CHECK (order_id IS NULL OR repair_id IS NULL);
CREATE UNIQUE INDEX invoice_one_live_bill_per_repair ON sales.invoice(tenant_id, repair_id) WHERE repair_id IS NOT NULL AND status <> 'cancelled';
-- sales_writer's INSERT on sales.invoice is column-level (992: row_rev is never writable)
GRANT INSERT (repair_id) ON sales.invoice TO sales_writer;

ALTER TABLE sales.invoice_line
  ALTER COLUMN item_id DROP NOT NULL, ALTER COLUMN purity_code DROP NOT NULL, ALTER COLUMN fineness DROP NOT NULL,
  ALTER COLUMN rate_id DROP NOT NULL, ALTER COLUMN mc_type DROP NOT NULL, ALTER COLUMN mc_value DROP NOT NULL;
-- goods lines keep every one of them (validated now: every existing row has them)
ALTER TABLE sales.invoice_line ADD CONSTRAINT invoice_line_goods_cols_check CHECK (line_kind = 'service'
  OR (item_id IS NOT NULL AND purity_code IS NOT NULL AND fineness IS NOT NULL AND rate_id IS NOT NULL AND mc_type IS NOT NULL AND mc_value IS NOT NULL));
