-- 974_platform_file.sql — metadata for files kept in object storage (imports, exports, attachments); never the blob.
-- Soft delete only: app_rw sets deleted_at; no row is ever removed by the API. platform.import_job gains file_id.
-- The 960 RLS/grant loops ran before this table existed, so policies and grants are set here explicitly (as in 973).

CREATE TABLE platform.file (
  tenant_id     uuid        NOT NULL REFERENCES platform.tenant(id),
  id            uuid        NOT NULL DEFAULT platform.uuid_v7(),
  area          text        NOT NULL CHECK (area IN ('imports','exports','attachments')),
  object_key    text        NOT NULL CONSTRAINT file_object_key_uq UNIQUE,
  original_name text        NOT NULL CHECK (char_length(original_name) BETWEEN 1 AND 255),
  content_type  text        NOT NULL,
  size_bytes    bigint      NOT NULL CHECK (size_bytes >= 0),
  sha256        bytea       NOT NULL CHECK (octet_length(sha256) = 32),   -- raw digest, same convention as code_hash/token_hash
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT file_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT file_created_by_fk FOREIGN KEY (tenant_id, created_by) REFERENCES platform.app_user(tenant_id, id)
);
COMMENT ON TABLE platform.file IS 'object-storage file metadata; soft delete via deleted_at (app_rw may update only that column)';

-- ---------- RLS (same policies the 960 loops give every platform tenant table) ----------
ALTER TABLE platform.file ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.file FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform.file
  USING (tenant_id = platform.current_tenant()) WITH CHECK (tenant_id = platform.current_tenant());
CREATE POLICY no_partner_access ON platform.file AS RESTRICTIVE
  USING (platform.current_partner() IS NULL) WITH CHECK (platform.current_partner() IS NULL);

-- ---------- grants ----------
REVOKE ALL ON platform.file FROM PUBLIC, app_rw, app_ro, app_worker;
GRANT SELECT, INSERT ON platform.file TO app_rw;
GRANT UPDATE (deleted_at) ON platform.file TO app_rw;        -- soft delete only; no DELETE
GRANT SELECT ON platform.file TO app_ro;                     -- convention: reports read every non-secret table
-- app_worker: none (no worker job touches files yet)

-- ---------- import_job.file_id: same-tenant link to the uploaded file ----------
ALTER TABLE platform.import_job ADD COLUMN file_id uuid;
ALTER TABLE platform.import_job ADD CONSTRAINT import_job_file_fk
  FOREIGN KEY (tenant_id, file_id) REFERENCES platform.file(tenant_id, id);
CREATE INDEX import_job_file_idx ON platform.import_job (tenant_id, file_id) WHERE file_id IS NOT NULL;
