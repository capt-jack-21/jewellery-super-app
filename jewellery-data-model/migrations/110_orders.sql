-- 110_orders.sql — customer/shop orders and repairs (retail only; orders/repairs may be outsourced to a vendor)
SET search_path = orders, platform, public;

CREATE TABLE orders.customer_order (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL, order_no text NOT NULL, order_date date NOT NULL DEFAULT current_date,
  order_type text NOT NULL DEFAULT 'customer' CHECK (order_type IN ('customer','shop')),
  customer_id uuid, priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  due_date date, status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_production','ready','delivered','cancelled')),
  rate_locked_per_g numeric(12,2), notes text,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, branch_id, order_no),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES masters.customer(tenant_id, id)
);
CREATE TABLE orders.order_line (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  order_id uuid NOT NULL, item_id uuid NOT NULL, purity_id uuid NOT NULL,
  pieces int NOT NULL DEFAULT 1, approx_wt platform.weight_g, size text, gender text,
  stones jsonb NOT NULL DEFAULT '[]', design_notes text,
  attachment_keys text[] NOT NULL DEFAULT '{}',          -- object-storage keys
  vendor_id uuid, assigned_at timestamptz, vendor_due date,   -- outsourced supplier (simple reference)
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','assigned','received','delivered','cancelled')),
  received_tag_id uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders.customer_order(tenant_id, id),
  FOREIGN KEY (tenant_id, vendor_id) REFERENCES masters.vendor(tenant_id, id),
  FOREIGN KEY (tenant_id, received_tag_id) REFERENCES inventory.tag(tenant_id, id)
);
ALTER TABLE sales.advance ADD FOREIGN KEY (tenant_id, order_id) REFERENCES orders.customer_order(tenant_id, id);

CREATE TABLE orders.repair (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL, repair_no text NOT NULL, received_on date NOT NULL DEFAULT current_date,
  customer_id uuid NOT NULL, due_date date,
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','issued_to_vendor','received_from_vendor','ready','delivered','cancelled')),
  delivered_invoice_id uuid,               -- repair charges are billed through sales.issue_invoice (service line)
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, branch_id, repair_no),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES masters.customer(tenant_id, id),
  FOREIGN KEY (tenant_id, delivered_invoice_id) REFERENCES sales.invoice(tenant_id, id)
);
CREATE TABLE orders.repair_line (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  repair_id uuid NOT NULL, repair_type_id uuid NOT NULL, description text,
  gross_wt platform.weight_g NOT NULL, net_wt platform.weight_g,
  customer_charge platform.money, vendor_id uuid, vendor_charge platform.money,
  issued_at timestamptz, received_at timestamptz, received_wt platform.weight_g,
  photo_keys text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, repair_id) REFERENCES orders.repair(tenant_id, id),
  FOREIGN KEY (tenant_id, repair_type_id) REFERENCES masters.repair_type(tenant_id, id)
);
