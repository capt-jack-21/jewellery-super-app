-- 01008: a fixed line number on order lines and repair lines, so screens and prints list lines in the order they were entered.
-- Lines saved in the same instant had no fixed order (listed by id). Existing rows are numbered by id; new lines take max + 1.
-- A cancelled line keeps its number (lines are never removed). Numbers are never reused.
ALTER TABLE orders.order_line  ADD COLUMN line_no int;
ALTER TABLE orders.repair_line ADD COLUMN line_no int;
UPDATE orders.order_line l SET line_no = n.rn
  FROM (SELECT tenant_id, id, row_number() OVER (PARTITION BY tenant_id, order_id ORDER BY id) AS rn FROM orders.order_line) n
 WHERE l.tenant_id = n.tenant_id AND l.id = n.id;
UPDATE orders.repair_line l SET line_no = n.rn
  FROM (SELECT tenant_id, id, row_number() OVER (PARTITION BY tenant_id, repair_id ORDER BY id) AS rn FROM orders.repair_line) n
 WHERE l.tenant_id = n.tenant_id AND l.id = n.id;
ALTER TABLE orders.order_line  ALTER COLUMN line_no SET NOT NULL, ADD CONSTRAINT order_line_line_no_check  CHECK (line_no >= 1);
ALTER TABLE orders.repair_line ALTER COLUMN line_no SET NOT NULL, ADD CONSTRAINT repair_line_line_no_check CHECK (line_no >= 1);
CREATE UNIQUE INDEX order_line_no_uq  ON orders.order_line  (tenant_id, order_id,  line_no);
CREATE UNIQUE INDEX repair_line_no_uq ON orders.repair_line (tenant_id, repair_id, line_no);
