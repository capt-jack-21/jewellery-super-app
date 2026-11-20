-- 080_inventory.sql — lots, tags (mandatory HUID), stones/diamonds, append-only stock ledger,
-- branch transfers, box weight checks. ONLY inventory_writer may append to the ledger or change tag status.
SET search_path = inventory, platform, public;

CREATE TABLE inventory.lot (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL, lot_no text NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('purchase','order_receipt','opening','refinery','transfer_in','other')),
  vendor_id uuid, ref_invoice_no text, ref_id uuid,       -- purchase / order id
  hallmark_centre text, hallmark_ref text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','tagged','closed')),
  received_on date NOT NULL DEFAULT current_date,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, branch_id, lot_no),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id),
  FOREIGN KEY (tenant_id, vendor_id) REFERENCES masters.vendor(tenant_id, id)
);

CREATE TABLE inventory.lot_line (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  lot_id uuid NOT NULL, item_id uuid NOT NULL, sub_item_id uuid,
  pieces int NOT NULL CHECK (pieces >= 0),
  gross_wt platform.weight_g NOT NULL, stone_wt platform.weight_g NOT NULL DEFAULT 0,
  net_wt platform.weight_g NOT NULL, other_wt platform.weight_g NOT NULL DEFAULT 0,
  tagged_pieces int NOT NULL DEFAULT 0, tagged_gross_wt platform.weight_g NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id),
  CHECK (net_wt <= gross_wt),
  FOREIGN KEY (tenant_id, lot_id) REFERENCES inventory.lot(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES masters.item(tenant_id, id),
  FOREIGN KEY (tenant_id, sub_item_id) REFERENCES masters.sub_item(tenant_id, id)
);

CREATE TABLE inventory.tag (               -- one row per physical piece
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL,                 -- current location
  tag_no varchar(30) NOT NULL,             -- barcode / QR payload
  lot_line_id uuid, item_id uuid NOT NULL, sub_item_id uuid, purity_id uuid NOT NULL,
  huid varchar(6) CHECK (huid ~ '^[A-Z0-9]{6}$'),   -- exactly 6 chars, UPPERCASE only: the app upper-cases input; the DB rejects (never silently fixes) anything else
  hallmark_exempt boolean NOT NULL DEFAULT false,  -- set by app from purity.huid_required (e.g. silver, <2 g)
  pieces int NOT NULL DEFAULT 1,
  gross_wt platform.weight_g NOT NULL, stone_wt platform.weight_g NOT NULL DEFAULT 0,
  net_wt platform.weight_g NOT NULL, cover_wt platform.weight_g NOT NULL DEFAULT 0, loop_wt platform.weight_g NOT NULL DEFAULT 0,
  size text,
  counter_id uuid, box_id uuid,
  mc_type text NOT NULL CHECK (mc_type IN ('per_gram','percent','flat','per_piece')),
  mc_value numeric(12,2) NOT NULL DEFAULT 0,
  wastage_pct platform.pct NOT NULL DEFAULT 0,
  min_wastage_pct platform.pct, max_wastage_pct platform.pct,
  min_sale_value platform.money, max_sale_value platform.money,   -- pricing guardrails
  huid_charge platform.money NOT NULL DEFAULT 0,
  cost_value platform.money,               -- masked unless inventory.tag.view_cost
  status text NOT NULL DEFAULT 'in_stock'
    CHECK (status IN ('in_stock','on_approval','in_transit','reserved','sold','returned_to_vendor','melted')),
  tagged_at timestamptz NOT NULL DEFAULT now(), tagged_by uuid,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, tag_no),
  CHECK (net_wt <= gross_wt),
  CHECK (huid IS NOT NULL OR hallmark_exempt),     -- mandatory HUID
  FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id),
  FOREIGN KEY (tenant_id, lot_line_id) REFERENCES inventory.lot_line(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES masters.item(tenant_id, id),
  FOREIGN KEY (tenant_id, sub_item_id) REFERENCES masters.sub_item(tenant_id, id),
  FOREIGN KEY (tenant_id, purity_id) REFERENCES masters.purity(tenant_id, id),
  FOREIGN KEY (tenant_id, counter_id) REFERENCES masters.counter(tenant_id, id),
  FOREIGN KEY (tenant_id, box_id) REFERENCES masters.box(tenant_id, id)
);
CREATE UNIQUE INDEX tag_huid_uq ON inventory.tag (tenant_id, huid) WHERE huid IS NOT NULL;
CREATE INDEX tag_stock_idx ON inventory.tag (tenant_id, branch_id, status, item_id);

CREATE TABLE inventory.tag_stone (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  tag_id uuid NOT NULL, is_diamond boolean NOT NULL DEFAULT false,
  stone_id uuid, shape_id uuid, cut_id uuid, clarity_id uuid, colour_id uuid, cent_group_id uuid,
  pieces int NOT NULL DEFAULT 1,
  weight numeric(12,3) NOT NULL CHECK (weight >= 0),       -- in weight_unit (ct/g/cent)
  weight_unit text NOT NULL DEFAULT 'ct' CHECK (weight_unit IN ('ct','g','cent')),
  rate_type text NOT NULL CHECK (rate_type IN ('per_ct','per_g','per_piece','flat')),
  rate platform.money NOT NULL DEFAULT 0, amount platform.money NOT NULL DEFAULT 0,
  certificate_no text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, tag_id) REFERENCES inventory.tag(tenant_id, id)
);
CREATE INDEX tag_stone_tag_idx ON inventory.tag_stone (tenant_id, tag_id);

-- Append-only stock ledger (pieces, gross, net and fine weight)
CREATE TABLE inventory.stock_ledger (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
  tag_id uuid, item_id uuid, purity_id uuid NOT NULL,   -- item NULL for loose old metal
  movement text NOT NULL CHECK (movement IN ('tagged','opening','sale','sales_return','cancel_reversal','transfer_out',
                                              'transfer_in','approval_out','approval_in','purchase_in','purchase_return',
                                              'old_metal_in','melt_out','refinery_in','adjustment','non_tag_in','non_tag_out')),
  direction smallint NOT NULL CHECK (direction IN (-1, 1)),
  pieces int NOT NULL DEFAULT 0,
  gross_wt platform.weight_g NOT NULL DEFAULT 0, net_wt platform.weight_g NOT NULL DEFAULT 0,
  fine_wt platform.weight_g NOT NULL DEFAULT 0,
  source_module text NOT NULL, source_type text NOT NULL, source_id uuid NOT NULL,
  user_id uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id),
  FOREIGN KEY (tenant_id, tag_id) REFERENCES inventory.tag(tenant_id, id)
);
CREATE INDEX stock_ledger_item_idx ON inventory.stock_ledger (tenant_id, branch_id, item_id, occurred_at);
CREATE INDEX stock_ledger_tag_idx ON inventory.stock_ledger (tenant_id, tag_id);
CREATE INDEX stock_ledger_src_idx ON inventory.stock_ledger (tenant_id, source_type, source_id);
-- append-only by grants: only inventory_writer may INSERT; nobody has UPDATE/DELETE (900_security.sql)

-- Tag status/location may only be changed by inventory_writer: enforced by COLUMN-level grants
-- (app_rw can update descriptive columns but not status/branch_id). Tags are never deleted (no grant).
SELECT platform.enable_audit('inventory.tag');

-- Branch stock transfer: draft -> approved -> in_transit -> received | returned
CREATE TABLE inventory.stock_transfer (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  transfer_no text NOT NULL, from_branch_id uuid NOT NULL, to_branch_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','in_transit','received','returned','cancelled')),
  requested_by uuid, approved_by uuid, received_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz, received_at timestamptz,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, transfer_no),
  CHECK (from_branch_id <> to_branch_id),
  FOREIGN KEY (tenant_id, from_branch_id) REFERENCES platform.branch(tenant_id, id),
  FOREIGN KEY (tenant_id, to_branch_id) REFERENCES platform.branch(tenant_id, id)
);
CREATE TABLE inventory.stock_transfer_line (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  transfer_id uuid NOT NULL, tag_id uuid, item_id uuid, purity_id uuid,
  pieces int NOT NULL DEFAULT 1, gross_wt platform.weight_g NOT NULL, net_wt platform.weight_g NOT NULL,
  received boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, transfer_id) REFERENCES inventory.stock_transfer(tenant_id, id),
  FOREIGN KEY (tenant_id, tag_id) REFERENCES inventory.tag(tenant_id, id)
);
SELECT platform.enable_audit('inventory.stock_transfer');

CREATE TABLE inventory.box_weight_check (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  box_id uuid NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(), checked_by uuid,
  expected_pieces int NOT NULL, expected_gross platform.weight_g NOT NULL, expected_net platform.weight_g NOT NULL,
  actual_pieces int NOT NULL, actual_gross platform.weight_g NOT NULL,
  diff_gross numeric(12,3) GENERATED ALWAYS AS (actual_gross - expected_gross) STORED,
  remarks text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, box_id) REFERENCES masters.box(tenant_id, id)
);

CREATE TABLE inventory.stock_take (        -- cycle count (suggested)
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
  scanned_tag_ids uuid[] NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id)
);
