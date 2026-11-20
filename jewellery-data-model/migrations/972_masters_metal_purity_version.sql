-- 972_masters_metal_purity_version.sql — optimistic concurrency + soft-disable for masters.metal / masters.purity.
-- Existing rows get version 1 / is_active true from the column defaults. The aa_version trigger is the same one
-- other tables use (platform.bump_version(), BEFORE INSERT OR UPDATE: INSERT resets to 1, UPDATE +1, a manual version change is rejected).
-- No grants: app_rw's table-level INSERT/UPDATE/DELETE and the writer roles' table-level SELECT on masters cover the new columns.

ALTER TABLE masters.metal  ADD COLUMN IF NOT EXISTS version   int     NOT NULL DEFAULT 1,
                           ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE masters.purity ADD COLUMN IF NOT EXISTS version   int     NOT NULL DEFAULT 1,
                           ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

DROP TRIGGER IF EXISTS aa_version ON masters.metal;
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON masters.metal  FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
DROP TRIGGER IF EXISTS aa_version ON masters.purity;
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON masters.purity FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
