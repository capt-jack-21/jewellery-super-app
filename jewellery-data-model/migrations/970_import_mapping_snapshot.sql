-- 970_import_mapping_snapshot.sql — freeze the column mapping an import used.
-- platform.import_job.mapping_snapshot (jsonb): the resolved mapping (from a saved profile or ad hoc) as validated.
--   * set once: on INSERT, or by the first UPDATE from NULL while the job is still in upload / dry-run state
--     (status uploaded, validating, validated); afterwards immutable (no change, no reset to NULL).
--   * commit = a real import (dry_run = false) moving to 'importing' or 'completed': requires a non-null snapshot
--     and its dry run (dry_run_of) to have passed (status 'validated').
-- A dry run moving to importing/completed is still rejected by the existing CHECK (left to it on purpose).
-- Grants: app_rw already holds table-level UPDATE on platform.import_job (900/960), which covers this column;
-- app_ro reads it via the schema-wide SELECT. No grant change needed.

ALTER TABLE platform.import_job ADD COLUMN mapping_snapshot jsonb
  CONSTRAINT import_job_mapping_snapshot_object CHECK (mapping_snapshot IS NULL OR jsonb_typeof(mapping_snapshot) = 'object');

CREATE FUNCTION platform.import_job_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE dry_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.mapping_snapshot IS DISTINCT FROM OLD.mapping_snapshot THEN
    IF OLD.mapping_snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'import_job.mapping_snapshot is immutable once set';
    END IF;
    IF OLD.status NOT IN ('uploaded','validating','validated') THEN
      RAISE EXCEPTION 'import_job.mapping_snapshot can only be set while the job is uploaded/validating/validated (is %)', OLD.status;
    END IF;
  END IF;
  IF NOT NEW.dry_run AND NEW.status IN ('importing','completed')
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    IF NEW.mapping_snapshot IS NULL THEN
      RAISE EXCEPTION 'import commit requires mapping_snapshot';
    END IF;
    SELECT j.status INTO dry_status FROM platform.import_job j
     WHERE j.tenant_id = NEW.tenant_id AND j.id = NEW.dry_run_of AND j.dry_run;
    IF dry_status IS DISTINCT FROM 'validated' THEN
      RAISE EXCEPTION 'import commit requires a passed dry run (dry run status %)', coalesce(dry_status, 'missing');
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION platform.import_job_snapshot_guard() FROM PUBLIC;

CREATE TRIGGER import_job_snapshot_guard BEFORE INSERT OR UPDATE ON platform.import_job
  FOR EACH ROW EXECUTE FUNCTION platform.import_job_snapshot_guard();
