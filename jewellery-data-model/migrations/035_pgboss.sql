-- 035_pgboss.sql — schema for pg-boss's own job tables. pg-boss (connecting as app_worker) creates and
-- migrates its tables here at startup. No tenant data; not covered by RLS. The DDL guard lets app_worker
-- change this schema and nothing else.
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION app_worker;
REVOKE ALL ON SCHEMA pgboss FROM PUBLIC;
GRANT USAGE ON SCHEMA pgboss TO app_ro;   -- read-only visibility for ops dashboards (pg-boss tables are owned by app_worker)
