-- 020_billing.sql — SaaS plans & subscriptions (our billing of the shop, NOT shop sales)
SET search_path = billing, platform, public;

CREATE TABLE billing.plan (                -- global catalogue
  code        text PRIMARY KEY,            -- 'lite','standard','pro'
  name        text NOT NULL,
  max_branches int, max_users int, max_counters int,
  modules     text[] NOT NULL,             -- {'sales','inventory','orders','refinery','accounts'}
  price_monthly platform.money NOT NULL,
  price_yearly  platform.money NOT NULL,
  is_active   boolean NOT NULL DEFAULT true
);

CREATE TABLE billing.subscription (
  tenant_id   uuid NOT NULL REFERENCES platform.tenant(id),
  id          uuid NOT NULL DEFAULT platform.uuid_v7(),
  plan_code   text NOT NULL REFERENCES billing.plan(code),
  status      text NOT NULL CHECK (status IN ('trial','active','past_due','grace','read_only','cancelled')),
  billing_cycle text NOT NULL CHECK (billing_cycle IN ('monthly','yearly')),
  current_period_start date NOT NULL,
  current_period_end   date NOT NULL,
  gateway     text, gateway_ref text,      -- Razorpay/Cashfree mandate id etc.
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX subscription_status_idx ON billing.subscription (tenant_id, status);

CREATE TABLE billing.subscription_invoice (   -- our GST invoice to the shop (own series, platform side)
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL DEFAULT platform.uuid_v7(),
  subscription_id uuid NOT NULL,
  period_start date NOT NULL, period_end date NOT NULL,
  amount      platform.money NOT NULL,
  gst_amount  platform.money NOT NULL,
  status      text NOT NULL CHECK (status IN ('due','paid','failed','void')),
  paid_at     timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES billing.subscription(tenant_id, id)
);

CREATE TABLE billing.usage_meter (
  tenant_id   uuid NOT NULL,
  period      date NOT NULL,               -- first day of month
  metric      text NOT NULL,               -- 'invoices','users','branches','whatsapp_msgs'
  value       bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period, metric)
);
