-- run as app_migrator (table owner): triggers must still block
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
SET client_min_messages = warning;
SET app.tenant_id = '00000000-0000-0000-0000-000000000001';
SELECT pg_temp.expect_error($$DELETE FROM sales.invoice$$, 'owner DELETE invoice blocked', '%not allowed%');
SELECT pg_temp.expect_error($$TRUNCATE sales.invoice CASCADE$$, 'owner TRUNCATE invoice blocked', '%not allowed%');
SELECT pg_temp.expect_error($$UPDATE sales.invoice SET invoice_total = 1$$, 'owner UPDATE invoice blocked', '%sales module role%');
SELECT pg_temp.expect_error($$INSERT INTO sales.invoice_line SELECT * FROM sales.invoice_line LIMIT 1$$, 'owner cannot add lines', '%not allowed%');
SELECT pg_temp.expect_error($$UPDATE sales.doc_series SET next_no = 1$$, 'owner cannot rewind series', '%only advance by 1%');
SELECT pg_temp.expect_error($$DELETE FROM sales.doc_series$$, 'owner cannot delete series', '%not allowed%');
SELECT pg_temp.expect_error($$DELETE FROM platform.audit_event$$, 'owner DELETE audit blocked', '%not allowed%');
SELECT pg_temp.expect_error($$UPDATE platform.audit_event SET action = 'x'$$, 'owner UPDATE audit blocked', '%not allowed%');
SELECT pg_temp.expect_error($$INSERT INTO notifications.outbox(tenant_id, topic, payload, ref_type, ref_id, alert_type)
       SELECT tenant_id, topic, payload, ref_type, ref_id, alert_type FROM notifications.outbox WHERE alert_type = 'sales_return'$$,
       'N8 duplicate (tenant, ref_type, ref_id, alert_type) alert rejected', '%outbox_alert_uq%');
