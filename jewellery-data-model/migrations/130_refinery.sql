-- 130_refinery.sql — bagging old metal, melting & purification jobs with loss tracking
SET search_path = refinery, platform, public;

CREATE TABLE refinery.bag (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL, bag_no text NOT NULL, metal_id uuid NOT NULL,
  gross_wt platform.weight_g NOT NULL DEFAULT 0, net_wt platform.weight_g NOT NULL DEFAULT 0,
  dust_wt platform.weight_g NOT NULL DEFAULT 0, fine_wt platform.weight_g NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','sealed','melting','purifying','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, bag_no)
);
CREATE TABLE refinery.bag_item (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  bag_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('invoice_old_metal','old_metal_purchase','sales_return','scrap','tag')),
  source_id uuid NOT NULL, gross_wt platform.weight_g NOT NULL, net_wt platform.weight_g NOT NULL, fine_wt platform.weight_g NOT NULL,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, source_type, source_id),
  FOREIGN KEY (tenant_id, bag_id) REFERENCES refinery.bag(tenant_id, id)
);
CREATE TABLE refinery.job (                 -- one row per issue; receipt fields filled on return
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  kind text NOT NULL CHECK (kind IN ('melting','purification')),
  job_no text NOT NULL, bag_id uuid NOT NULL, parent_job_id uuid, vendor_id uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(), due_date date,
  issued_gross_wt platform.weight_g NOT NULL, issued_fine_wt platform.weight_g NOT NULL,
  issued_touch_pct platform.pct, bullion_rate numeric(12,2), stone_wt platform.weight_g NOT NULL DEFAULT 0,
  expected_return_wt platform.weight_g,
  received_at timestamptz, received_wt platform.weight_g, received_touch_pct platform.pct, received_fine_wt platform.weight_g,
  loss_wt numeric(12,3) GENERATED ALWAYS AS (issued_fine_wt - received_fine_wt) STORED,
  charges platform.money NOT NULL DEFAULT 0,
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','metal_adjusted')),
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','received','closed')),
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, kind, job_no),
  FOREIGN KEY (tenant_id, bag_id) REFERENCES refinery.bag(tenant_id, id),
  FOREIGN KEY (tenant_id, parent_job_id) REFERENCES refinery.job(tenant_id, id),
  FOREIGN KEY (tenant_id, vendor_id) REFERENCES masters.vendor(tenant_id, id)
);
