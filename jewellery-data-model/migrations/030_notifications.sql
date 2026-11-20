-- 030_notifications.sql — transactional outbox delivered by pg-boss worker (INV-5 alerts live here)
SET search_path = notifications, platform, public;

CREATE TABLE notifications.outbox (
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL DEFAULT platform.uuid_v7(),
  topic       text NOT NULL,               -- 'alert.invoice_cancelled','alert.sales_return','bill.whatsapp', ...
  payload     jsonb NOT NULL,
  priority    smallint NOT NULL DEFAULT 5,
  ref_type    text,                        -- what the message is about, e.g. 'credit_note', 'invoice', 'import_job'
  ref_id      uuid,
  alert_type  text CHECK (alert_type IN ('invoice_cancelled','sales_return')),   -- INV-5 alerts; set only by the credit-note trigger
  created_at  timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','sent','failed','dead')),
  attempts    int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claimed_at  timestamptz, claimed_by text,          -- worker id (pg-boss job id / hostname)
  sent_at     timestamptz,
  last_error  text,
  PRIMARY KEY (tenant_id, id),
  CHECK ((ref_type IS NULL) = (ref_id IS NULL)),
  CHECK (alert_type IS NULL OR ref_type = 'credit_note'),
  CHECK ((topic IN ('alert.invoice_cancelled','alert.sales_return')) = (alert_type IS NOT NULL))
);
-- N8: one alert of each type per referenced document
CREATE UNIQUE INDEX outbox_alert_uq ON notifications.outbox (tenant_id, ref_type, ref_id, alert_type) WHERE alert_type IS NOT NULL;
CREATE INDEX outbox_pending_idx ON notifications.outbox (available_at) WHERE status IN ('pending','failed');
-- Worker claim pattern (cross-tenant, see 900_security.sql policy worker_*):
--   UPDATE notifications.outbox SET status='claimed', claimed_at=now(), claimed_by=$1, attempts=attempts+1
--    WHERE (tenant_id, id) IN (SELECT tenant_id, id FROM notifications.outbox
--          WHERE status IN ('pending','failed') AND available_at <= now()
--          ORDER BY priority, available_at LIMIT 50 FOR UPDATE SKIP LOCKED)
--   RETURNING *;

CREATE TABLE notifications.template (
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL DEFAULT platform.uuid_v7(),
  topic       text NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('in_app','whatsapp','sms','email','push')),
  locale      text NOT NULL DEFAULT 'en',
  body        text NOT NULL,
  dlt_template_id text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, topic, channel, locale)
);

CREATE TABLE notifications.in_app_alert (
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL DEFAULT platform.uuid_v7(),
  user_id     uuid NOT NULL,
  outbox_id   uuid,
  title       text NOT NULL,
  body        text NOT NULL,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES platform.app_user(tenant_id, id)
);

-- Producers insert outbox rows in the same transaction as the business event (app layer).
