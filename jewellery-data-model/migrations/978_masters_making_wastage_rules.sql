-- 978_masters_making_wastage_rules.sql — M6 making-charge + M7 wastage/VA rules on the existing masters.value_addition_rule.
-- Already there: scope customer|designer, tier, metal/item/sub_item/vendor targets, weight band, touch, wastage_pct,
-- flat_wastage, mc_per_gram, flat_mc, fixed_rate. Added here:
--   * mc_percent (percent-of-metal-value making charge) -> per gram | percent | fixed are all expressible
--   * purity_id and design_id targets (by category = item/sub_item, by product = design)
--   * effective_from/effective_to (NULL from = always), priority (app picks the most specific, then highest priority),
--     is_active, version, created_at
--   * the missing FKs (metal, sub_item) and sanity CHECKs. Constraints touching existing columns are NOT VALID so
--     existing dev rows are not re-checked; new/updated rows are. Rule selection stays in the app (no DB function).

ALTER TABLE masters.value_addition_rule
  ADD COLUMN purity_id      uuid,
  ADD COLUMN design_id      uuid,
  ADD COLUMN mc_percent         platform.pct,
  ADD COLUMN effective_from date,
  ADD COLUMN effective_to   date,
  ADD COLUMN priority       int NOT NULL DEFAULT 0,
  ADD COLUMN is_active      boolean NOT NULL DEFAULT true,
  ADD COLUMN version        int NOT NULL DEFAULT 1,
  ADD COLUMN created_at     timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT var_purity_fk   FOREIGN KEY (tenant_id, purity_id)   REFERENCES masters.purity(tenant_id, id),
  ADD CONSTRAINT var_design_fk   FOREIGN KEY (tenant_id, design_id)   REFERENCES masters.design(tenant_id, id),
  ADD CONSTRAINT var_metal_fk    FOREIGN KEY (tenant_id, metal_id)    REFERENCES masters.metal(tenant_id, id) NOT VALID,
  ADD CONSTRAINT var_sub_item_fk FOREIGN KEY (tenant_id, sub_item_id) REFERENCES masters.sub_item(tenant_id, id) NOT VALID,
  ADD CONSTRAINT var_mc_percent_range CHECK (mc_percent IS NULL OR (mc_percent >= 0 AND mc_percent <= 100)),
  ADD CONSTRAINT var_period CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from),
  ADD CONSTRAINT var_one_mc_basis CHECK (num_nonnulls(mc_per_gram, mc_percent, flat_mc) <= 1) NOT VALID,
  ADD CONSTRAINT var_one_wastage_basis CHECK (num_nonnulls(wastage_pct, flat_wastage) <= 1) NOT VALID,
  ADD CONSTRAINT var_nonneg CHECK (coalesce(mc_per_gram, 0) >= 0 AND coalesce(flat_mc, 0) >= 0 AND coalesce(fixed_rate, 0) >= 0
                                   AND coalesce(wastage_pct, 0) BETWEEN 0 AND 100 AND coalesce(touch, 0) BETWEEN 0 AND 100) NOT VALID,
  ADD CONSTRAINT var_weight_band CHECK (weight_to IS NULL OR weight_to > weight_from) NOT VALID;
CREATE INDEX value_addition_rule_lookup_idx ON masters.value_addition_rule (tenant_id, scope, item_id, design_id);

CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON masters.value_addition_rule FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
SELECT platform.enable_audit('masters.value_addition_rule');
-- Grants: unchanged (960 table-level grants cover the new columns).
