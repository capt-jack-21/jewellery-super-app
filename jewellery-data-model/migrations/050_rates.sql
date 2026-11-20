-- 050_rates.sql — daily selling rates & old-metal (exchange) rates, effective-dated, audited
SET search_path = rates, platform, public;

CREATE TABLE rates.metal_rate (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid,                                          -- NULL = all branches; branch row overrides
  purity_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('sale','old_metal','purchase')),
  rate_date date NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),       -- intraday revisions allowed
  rate_per_g numeric(12,2) NOT NULL CHECK (rate_per_g > 0),
  source text NOT NULL DEFAULT 'manual',                   -- manual / association feed
  published_by uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id),
  FOREIGN KEY (tenant_id, purity_id) REFERENCES masters.purity(tenant_id, id)
);
CREATE UNIQUE INDEX metal_rate_uq ON rates.metal_rate
  (tenant_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), purity_id, kind, effective_from);
CREATE INDEX metal_rate_lookup_idx ON rates.metal_rate (tenant_id, purity_id, kind, effective_from DESC);
SELECT platform.enable_audit('rates.metal_rate');
-- Rate lookup (branch override beats tenant-wide; latest effective_from) is done by the rates service.
