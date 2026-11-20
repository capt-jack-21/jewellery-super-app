-- 977_masters_stone_rates.sql — M5 stones/diamonds: type, carat band, clarity, colour, cut, shape, rate per carat.
-- Reuses what exists: masters.stone_standard (kinds stone/shape/cut/clarity/colour/cent_group, cent_from/to bands) is the
-- attribute catalogue; masters.diamond_rate becomes the general stone rate card (diamonds AND colour stones):
--   * stone_id: the stone type (stone_standard kind 'stone'); NULL = diamond row as before
--   * cent_group_id becomes optional (colour stones are often priced without a size band)
--   * rate_unit per_ct | per_piece (default per_ct = existing rows' meaning), effective_to, is_active, version
--   * real FKs for every attribute + vendor. They are NOT VALID so pre-existing rows on dev are not re-checked
--     (new/updated rows are); run VALIDATE CONSTRAINT after checking dev data. Attribute *kind* is checked by the app.
-- stone_standard gains is_active + version. Both tables get the zz_audit trigger (rates are price data).

ALTER TABLE masters.stone_standard
  ADD COLUMN is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN version   int     NOT NULL DEFAULT 1,
  ADD CONSTRAINT stone_standard_cent_band CHECK (cent_from IS NULL OR cent_to IS NULL OR cent_to > cent_from) NOT VALID;

ALTER TABLE masters.diamond_rate
  ALTER COLUMN cent_group_id DROP NOT NULL,
  ADD COLUMN stone_id      uuid,
  ADD COLUMN rate_unit     text NOT NULL DEFAULT 'per_ct' CONSTRAINT diamond_rate_rate_unit_check CHECK (rate_unit IN ('per_ct','per_piece')),
  ADD COLUMN effective_to  date,
  ADD COLUMN is_active     boolean NOT NULL DEFAULT true,
  ADD COLUMN version       int     NOT NULL DEFAULT 1,
  ADD COLUMN created_at    timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT diamond_rate_period CHECK (effective_to IS NULL OR effective_to > effective_from) NOT VALID,
  ADD CONSTRAINT diamond_rate_rates_nonneg CHECK (sale_rate_per_ct >= 0 AND (purchase_rate_per_ct IS NULL OR purchase_rate_per_ct >= 0)) NOT VALID,
  ADD CONSTRAINT diamond_rate_has_key CHECK (stone_id IS NOT NULL OR cent_group_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT diamond_rate_stone_fk   FOREIGN KEY (tenant_id, stone_id)   REFERENCES masters.stone_standard(tenant_id, id) NOT VALID,
  ADD CONSTRAINT diamond_rate_shape_fk   FOREIGN KEY (tenant_id, shape_id)   REFERENCES masters.stone_standard(tenant_id, id) NOT VALID,
  ADD CONSTRAINT diamond_rate_clarity_fk FOREIGN KEY (tenant_id, clarity_id) REFERENCES masters.stone_standard(tenant_id, id) NOT VALID,
  ADD CONSTRAINT diamond_rate_colour_fk  FOREIGN KEY (tenant_id, colour_id)  REFERENCES masters.stone_standard(tenant_id, id) NOT VALID,
  ADD CONSTRAINT diamond_rate_cut_fk     FOREIGN KEY (tenant_id, cut_id)     REFERENCES masters.stone_standard(tenant_id, id) NOT VALID,
  ADD CONSTRAINT diamond_rate_vendor_fk  FOREIGN KEY (tenant_id, vendor_id)  REFERENCES masters.vendor(tenant_id, id) NOT VALID;
COMMENT ON COLUMN masters.diamond_rate.sale_rate_per_ct IS 'sale rate per rate_unit (per carat by default; per piece when rate_unit = per_piece)';
CREATE INDEX diamond_rate_lookup_idx ON masters.diamond_rate (tenant_id, stone_id, cent_group_id, effective_from DESC);

CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON masters.stone_standard FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON masters.diamond_rate   FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
SELECT platform.enable_audit('masters.stone_standard');
SELECT platform.enable_audit('masters.diamond_rate');
-- Grants: unchanged. Both tables already carry 960's table-level grants (app_rw CRUD, app_ro + writers SELECT), which cover new columns.
