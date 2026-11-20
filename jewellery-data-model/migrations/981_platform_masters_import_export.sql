-- 981_platform_masters_import_export.sql — M17 bulk import/export of masters.
-- Exists already: platform.import_job (dry run -> commit, mapping_snapshot 970, file_id 974), import_row_error,
-- import_mapping_profile, platform.file (area 'exports'). Kinds were customers|stock|opening_balances only. Added here:
--   * the master entity kinds on import_job.kind and import_mapping_profile.kind (same list on both)
--   * platform.export_job: a requested export (kind, format, filters) whose output is a platform.file row
-- Export content (which columns, PII masking) is the app's job; secret columns are never exported by the DB.

ALTER TABLE platform.import_job DROP CONSTRAINT import_job_kind_check;
ALTER TABLE platform.import_job ADD CONSTRAINT import_job_kind_check CHECK (kind IN (
  'customers','stock','opening_balances',
  'metals','purities','items','sub_items','designs','stones','stone_rates','making_wastage_rules',
  'vendors','staff','counters','trays','hsn_codes','payment_modes','bank_accounts','card_machines'));
ALTER TABLE platform.import_mapping_profile DROP CONSTRAINT import_mapping_profile_kind_check;
ALTER TABLE platform.import_mapping_profile ADD CONSTRAINT import_mapping_profile_kind_check CHECK (kind IN (
  'customers','stock','opening_balances',
  'metals','purities','items','sub_items','designs','stones','stone_rates','making_wastage_rules',
  'vendors','staff','counters','trays','hsn_codes','payment_modes','bank_accounts','card_machines'));

CREATE TABLE platform.export_job (
  tenant_id   uuid NOT NULL REFERENCES platform.tenant(id),
  id          uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id   uuid,
  kind        text NOT NULL CONSTRAINT export_job_kind_check CHECK (kind IN (
                'customers','stock','opening_balances',
                'metals','purities','items','sub_items','designs','stones','stone_rates','making_wastage_rules',
                'vendors','staff','counters','trays','hsn_codes','payment_modes','bank_accounts','card_machines')),
  format      text NOT NULL DEFAULT 'xlsx' CHECK (format IN ('csv','xlsx')),
  filters     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(filters) = 'object'),
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  file_id     uuid,                                   -- the produced file (platform.file area 'exports')
  row_count   int CHECK (row_count >= 0),
  error       text,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz,
  version     int NOT NULL DEFAULT 1,
  CONSTRAINT export_job_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT export_job_completed_has_file CHECK (status <> 'completed' OR (file_id IS NOT NULL AND finished_at IS NOT NULL)),
  CONSTRAINT export_job_branch_fk  FOREIGN KEY (tenant_id, branch_id)  REFERENCES platform.branch(tenant_id, id),
  CONSTRAINT export_job_file_fk    FOREIGN KEY (tenant_id, file_id)    REFERENCES platform.file(tenant_id, id),
  CONSTRAINT export_job_creator_fk FOREIGN KEY (tenant_id, created_by) REFERENCES platform.app_user(tenant_id, id)
);
CREATE INDEX export_job_recent_idx ON platform.export_job (tenant_id, created_at DESC);

CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON platform.export_job FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
SELECT platform.enable_audit('platform.export_job');

ALTER TABLE platform.export_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.export_job FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform.export_job
  USING (tenant_id = platform.current_tenant()) WITH CHECK (tenant_id = platform.current_tenant());
CREATE POLICY no_partner_access ON platform.export_job AS RESTRICTIVE
  USING (platform.current_partner() IS NULL) WITH CHECK (platform.current_partner() IS NULL);

-- grants: like platform.import_job (app_rw insert/update, no delete; reports read; writers and worker none)
REVOKE ALL ON platform.export_job FROM PUBLIC, app_rw, app_ro, app_worker;
GRANT SELECT, INSERT, UPDATE ON platform.export_job TO app_rw;
GRANT SELECT ON platform.export_job TO app_ro;
