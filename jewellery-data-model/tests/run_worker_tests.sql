-- run as app_worker (pg-boss). No app.tenant_id set: the worker is cross-tenant by policy.
\set ON_ERROR_STOP 1
\pset tuples_only on
CREATE FUNCTION pg_temp.expect_error(p_sql text, p_label text, p_like text DEFAULT '%') RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE p_like THEN RETURN 'PASS  ' || p_label || '  -> ' || SQLERRM; END IF;
    RAISE EXCEPTION 'FAIL  % wrong error: %', p_label, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL  % : statement unexpectedly succeeded', p_label;
END $$;
CREATE FUNCTION pg_temp.check(ok boolean, p_label text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN IF ok THEN RETURN 'PASS  ' || p_label; END IF; RAISE EXCEPTION 'FAIL  %', p_label; END $$;
SET client_min_messages = warning;

CREATE TABLE pgboss.worker_probe (id int);
INSERT INTO pgboss.worker_probe VALUES (1);
DROP TABLE pgboss.worker_probe;
SELECT pg_temp.check(true, 'worker can CREATE/DROP tables in schema pgboss');
SELECT pg_temp.expect_error($$CREATE TABLE notifications.evil (id int)$$, 'worker cannot DDL in notifications', '%permission denied%');
SELECT pg_temp.expect_error($$CREATE TABLE public.evil (id int)$$, 'worker cannot DDL in public', '%permission denied%');
SELECT pg_temp.expect_error($$CREATE TEMP TABLE probe AS SELECT 1; CREATE INDEX ON pg_temp.probe ((1)); CREATE VIEW pgboss.v AS SELECT 1; ALTER VIEW pgboss.v SET SCHEMA notifications$$,
       'worker cannot move objects out of pgboss', '%');

-- claim across tenants (SKIP LOCKED pattern)
WITH c AS (
  UPDATE notifications.outbox SET status = 'claimed', claimed_at = now(), claimed_by = 'test-worker', attempts = attempts + 1
   WHERE (tenant_id, id) IN (SELECT tenant_id, id FROM notifications.outbox WHERE status IN ('pending','failed')
                             AND available_at <= now() ORDER BY priority, available_at LIMIT 50 FOR UPDATE SKIP LOCKED)
  RETURNING topic)
SELECT pg_temp.check(count(*) >= 1 AND bool_or(topic = 'alert.invoice_cancelled'), 'worker claims outbox rows across tenants (no tenant set)') FROM c;
UPDATE notifications.outbox SET status = 'sent', sent_at = now() WHERE claimed_by = 'test-worker';
SELECT pg_temp.check((SELECT count(*) FROM notifications.outbox WHERE status = 'sent') >= 1, 'worker marks rows sent');
SELECT pg_temp.expect_error($$UPDATE notifications.outbox SET payload = '{}'$$, 'worker cannot alter alert payload', '%permission denied%');
SELECT pg_temp.expect_error($$UPDATE notifications.outbox SET topic = 'x'$$, 'worker cannot alter topic', '%permission denied%');
SELECT pg_temp.expect_error($$INSERT INTO notifications.outbox(tenant_id, topic, payload) VALUES ('00000000-0000-0000-0000-000000000001','alert.invoice_cancelled','{}')$$,
       'worker cannot insert (fabricate) cancellation alerts', '%permission denied%');
SELECT pg_temp.expect_error($$DELETE FROM notifications.outbox$$, 'worker cannot delete alerts', '%permission denied%');
SELECT pg_temp.expect_error($$SELECT count(*) FROM sales.invoice$$, 'worker cannot read sales tables', '%permission denied%');
SELECT pg_temp.expect_error($$UPDATE sales.invoice SET status = 'cancelled'$$, 'worker cannot touch sales tables', '%permission denied%');
SELECT pg_temp.expect_error($$SELECT count(*) FROM inventory.tag$$, 'worker cannot read inventory', '%permission denied%');

WITH d AS (DELETE FROM sales.idempotency_key RETURNING key)
SELECT pg_temp.check(count(*) = 1 AND min(key) = 'idem-expired-0001', 'retention job deletes only idempotency keys older than 24h') FROM d;

-- R8 OTP delivery queue: worker reads ciphertext and deletes after sending; cannot insert/update
SELECT pg_temp.check((SELECT count(*) FROM platform.otp_delivery) = 1, 'R8 worker reads pending OTP deliveries across tenants');
SELECT pg_temp.expect_error($$UPDATE platform.otp_delivery SET key_id = 'x'$$, 'R8 worker cannot update OTP deliveries', '%permission denied%');
SELECT pg_temp.expect_error($$INSERT INTO platform.otp_delivery SELECT * FROM platform.otp_delivery$$, 'R8 worker cannot insert OTP deliveries', '%permission denied%');
WITH d AS (DELETE FROM platform.otp_delivery RETURNING 1) SELECT pg_temp.check(count(*) = 1, 'R8 worker deletes the row after sending') FROM d;
SELECT pg_temp.expect_error($$SELECT * FROM platform.otp_challenge$$, 'R8 worker cannot read OTP hashes', '%permission denied%');

-- 973 platform.idempotency_key purge: worker sees/deletes only expired rows
SELECT pg_temp.check((SELECT count(*) FROM platform.idempotency_key) = 2, 'IK21 worker sees only the 2 expired idempotency keys (both tenants)');
WITH d AS (DELETE FROM platform.idempotency_key RETURNING key)
  SELECT pg_temp.check(count(*) = 2 AND string_agg(key, ',' ORDER BY key) = 'idem-gst-expired,idem-t2-expired', 'IK22 worker purge deletes only expires_at < now(), across tenants') FROM d;
SELECT pg_temp.expect_error($$UPDATE platform.idempotency_key SET response_status = 500$$, 'IK23 worker cannot update idempotency keys', '%permission denied%');
SELECT pg_temp.expect_error($$INSERT INTO platform.idempotency_key(tenant_id, scope, key, request_hash, response_status, response_body)
       VALUES ('00000000-0000-0000-0000-000000000001', 'POST /v1/x', 'k-w', 'h', 200, '{}')$$, 'IK24 worker cannot insert idempotency keys', '%permission denied%');

-- S2 worker purges rate-limit windows; cannot write them
WITH d AS (DELETE FROM platform.rate_limit_bucket WHERE window_start < now() + interval '1 day' RETURNING 1)
  SELECT pg_temp.check(count(*) >= 1, 'S2 worker purges expired rate-limit windows') FROM d;
SELECT pg_temp.expect_error($$INSERT INTO platform.rate_limit_bucket(bucket_key, window_start) VALUES ('login.admin:-:' || encode(sha256('y'),'hex'), now())$$,
       'S2 worker cannot create buckets', '%permission denied%');
