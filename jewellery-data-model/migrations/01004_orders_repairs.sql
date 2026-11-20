-- 01004 Orders O7: create a repair. Notes and creator on the repair, a cancel flag on repair lines (orders_writer has no DELETE),
-- and a repair link on advances (a money advance can be taken when a repair is booked; redeemed at delivery in O9).
ALTER TABLE orders.repair
  ADD COLUMN notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  ADD COLUMN created_by uuid,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE orders.repair_line
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  ADD CONSTRAINT repair_line_wt_chk CHECK (gross_wt > 0 AND (net_wt IS NULL OR net_wt <= gross_wt)),
  ADD CONSTRAINT repair_line_desc_chk CHECK (description IS NULL OR length(description) <= 500);
ALTER TABLE sales.advance
  ADD COLUMN repair_id uuid,
  ADD CONSTRAINT advance_repair_fk FOREIGN KEY (tenant_id, repair_id) REFERENCES orders.repair(tenant_id, id),
  ADD CONSTRAINT advance_order_or_repair_chk CHECK (order_id IS NULL OR repair_id IS NULL);
CREATE INDEX advance_repair_idx ON sales.advance(tenant_id, repair_id) WHERE repair_id IS NOT NULL;
