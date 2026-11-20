-- 01001 Orders O3/O4: cancel reason on the order, vendor note on the line, and checks that keep the status flow honest.
-- Metal issued to a vendor is only a free-text note on the line until Accounts exists (freeze O3).
ALTER TABLE orders.customer_order
  ADD COLUMN cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 3 AND 500),
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancelled_by uuid,
  ADD CONSTRAINT customer_order_cancel_chk CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL));
ALTER TABLE orders.order_line
  ADD COLUMN vendor_note text CHECK (vendor_note IS NULL OR length(vendor_note) <= 500),
  ADD CONSTRAINT order_line_assigned_chk CHECK (status NOT IN ('assigned','received') OR (vendor_id IS NOT NULL AND vendor_due IS NOT NULL));
