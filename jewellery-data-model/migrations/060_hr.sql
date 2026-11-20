-- 060_hr.sql — staff, departments, designations, counter targets, incentive slabs/accruals
SET search_path = hr, platform, public;

CREATE TABLE hr.department (tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  name text NOT NULL, PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, name));
CREATE TABLE hr.designation (tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  name text NOT NULL, PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, name));

CREATE TABLE hr.staff (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  code varchar(20) NOT NULL, name text NOT NULL, phone varchar(15),
  branch_id uuid NOT NULL, department_id uuid, designation_id uuid,
  pan_enc bytea, aadhaar_last4 varchar(4), address jsonb NOT NULL DEFAULT '{}', attachments jsonb NOT NULL DEFAULT '[]',
  joined_on date, left_on date,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES hr.department(tenant_id, id),
  FOREIGN KEY (tenant_id, designation_id) REFERENCES hr.designation(tenant_id, id)
);
ALTER TABLE platform.app_user ADD FOREIGN KEY (tenant_id, staff_id) REFERENCES hr.staff(tenant_id, id);

CREATE TABLE hr.counter_target (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  counter_id uuid, staff_id uuid,                  -- counter target or per-staff target
  period_from date NOT NULL, period_to date NOT NULL,
  target_amount platform.money, target_pieces int, target_weight platform.weight_g,
  PRIMARY KEY (tenant_id, id),
  CHECK (counter_id IS NOT NULL OR staff_id IS NOT NULL), CHECK (period_to >= period_from),
  FOREIGN KEY (tenant_id, counter_id) REFERENCES masters.counter(tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES hr.staff(tenant_id, id)
);

CREATE TABLE hr.incentive_slab (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  incentive_type text NOT NULL,                    -- e.g. 'gold_sale','diamond_sale'
  amount_from platform.money NOT NULL, amount_to platform.money,
  calc text NOT NULL CHECK (calc IN ('percent','fixed')), value numeric(12,3) NOT NULL,
  effective_from date NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE hr.incentive_accrual (                -- written by a job from issued invoices; reversed on credit notes
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  staff_id uuid NOT NULL, source_type text NOT NULL CHECK (source_type IN ('invoice','credit_note')),
  source_id uuid NOT NULL, slab_id uuid, amount platform.money NOT NULL,
  accrued_on date NOT NULL, paid_on date,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, staff_id, source_type, source_id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES hr.staff(tenant_id, id)
);
