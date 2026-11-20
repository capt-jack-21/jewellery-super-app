-- 090_approvals.sql — generic approval engine (rules -> requests) + goods-on-approval memos
SET search_path = approvals, platform, public;

CREATE TABLE approvals.rule (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  action_code text NOT NULL,      -- 'sales.below_min_price','estimate.discount','inventory.transfer','sales.backdate','inventory.adjustment'
  branch_id uuid, approver_role_id uuid, approver_user_ids uuid[] NOT NULL DEFAULT '{}',
  threshold jsonb NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, approver_role_id) REFERENCES platform.role(tenant_id, id)
);

CREATE TABLE approvals.request (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  rule_id uuid, action_code text NOT NULL, branch_id uuid NOT NULL,
  ref_type text NOT NULL, ref_id uuid,      -- e.g. 'tag' / tag id for below-min pricing
  details jsonb NOT NULL DEFAULT '{}',      -- requested price, discount, ...
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired','consumed')),
  requested_by uuid NOT NULL, requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid, decided_at timestamptz, decision_note text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES approvals.rule(tenant_id, id),
  CHECK (status NOT IN ('approved','denied') OR (decided_by IS NOT NULL AND decided_by <> requested_by))
);
CREATE INDEX approval_pending_idx ON approvals.request (tenant_id, branch_id, status);
SELECT platform.enable_audit('approvals.request');

CREATE TABLE approvals.memo (               -- goods on approval (requisition) to customer or shop
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id uuid NOT NULL, memo_no text NOT NULL,
  customer_id uuid, vendor_id uuid, receiver_name text NOT NULL, salesperson_id uuid,
  issued_at timestamptz NOT NULL DEFAULT now(), due_back date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','partly_closed','closed')),
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, branch_id, memo_no)
);
CREATE TABLE approvals.memo_line (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT platform.uuid_v7(),
  memo_id uuid NOT NULL, tag_id uuid NOT NULL,
  outcome text NOT NULL DEFAULT 'out' CHECK (outcome IN ('out','returned','sold')),
  invoice_id uuid, closed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, memo_id) REFERENCES approvals.memo(tenant_id, id),
  FOREIGN KEY (tenant_id, tag_id) REFERENCES inventory.tag(tenant_id, id)
);
