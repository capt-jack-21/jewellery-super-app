-- 01005 Orders O8: issue a repair line to a vendor and receive it back. Notes on the line, the recorded reason (and who) when a weight loss
-- above the shop tolerance was accepted with orders.repair.loss_override, and checks that keep the line's vendor state honest.
ALTER TABLE orders.repair_line
  ADD COLUMN vendor_note text CHECK (vendor_note IS NULL OR length(vendor_note) <= 500),
  ADD COLUMN loss_override_reason text CHECK (loss_override_reason IS NULL OR length(btrim(loss_override_reason)) BETWEEN 3 AND 300),
  ADD COLUMN loss_override_by uuid,
  ADD CONSTRAINT repair_line_issue_chk CHECK (issued_at IS NULL OR vendor_id IS NOT NULL),
  ADD CONSTRAINT repair_line_receive_chk CHECK (received_at IS NULL OR (issued_at IS NOT NULL AND received_wt IS NOT NULL AND received_wt > 0));
