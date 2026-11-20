-- 976_masters_design_photo.sql — M4 product/design catalogue with photos stored as platform.file rows.
-- masters.item / masters.sub_item stay the categories (M3); a design is a sellable model within a category
-- (e.g. "Lakshmi haram LH-102"), optionally from a designer vendor. Stock pieces (inventory.tag) are not linked yet.
-- The 960 RLS/grant loops ran before these tables existed, so policies and grants are set here (as in 973/974).
-- No new DB functions: platform.bump_version (aa_version) and platform.audit_row (zz_audit) are reused.

CREATE TABLE masters.design (
  tenant_id        uuid NOT NULL REFERENCES platform.tenant(id),
  id               uuid NOT NULL DEFAULT platform.uuid_v7(),
  code             varchar(30) NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,29}$'),
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 140),
  item_id          uuid NOT NULL,                          -- category (M3)
  sub_item_id      uuid,
  purity_id        uuid,                                   -- default purity; NULL = any purity of the item's metal
  designer_id      uuid,                                   -- masters.vendor with kind 'designer' (kind checked by the app)
  description      text,
  approx_gross_wt  platform.weight_g,                      -- numeric(12,3) grams
  approx_net_wt    platform.weight_g,
  approx_stone_wt  numeric(12,3) CHECK (approx_stone_wt >= 0),   -- carats
  size             text,
  tags             text[] NOT NULL DEFAULT '{}',
  is_active        boolean NOT NULL DEFAULT true,
  version          int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT design_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT design_code_uq UNIQUE (tenant_id, code),
  CONSTRAINT design_net_le_gross CHECK (approx_net_wt IS NULL OR approx_gross_wt IS NULL OR approx_net_wt <= approx_gross_wt),
  CONSTRAINT design_item_fk     FOREIGN KEY (tenant_id, item_id)     REFERENCES masters.item(tenant_id, id),
  CONSTRAINT design_sub_item_fk FOREIGN KEY (tenant_id, sub_item_id) REFERENCES masters.sub_item(tenant_id, id),
  CONSTRAINT design_purity_fk   FOREIGN KEY (tenant_id, purity_id)   REFERENCES masters.purity(tenant_id, id),
  CONSTRAINT design_designer_fk FOREIGN KEY (tenant_id, designer_id) REFERENCES masters.vendor(tenant_id, id)
);
CREATE INDEX design_item_idx ON masters.design (tenant_id, item_id);
CREATE INDEX design_name_idx ON masters.design (tenant_id, lower(name));

CREATE TABLE masters.design_photo (
  tenant_id   uuid NOT NULL REFERENCES platform.tenant(id),
  id          uuid NOT NULL DEFAULT platform.uuid_v7(),
  design_id   uuid NOT NULL,
  file_id     uuid NOT NULL,                               -- platform.file (area 'attachments'); the blob stays in object storage
  sort_order  int NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  is_primary  boolean NOT NULL DEFAULT false,
  caption     text CHECK (caption IS NULL OR char_length(caption) <= 200),
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT design_photo_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT design_photo_file_uq UNIQUE (tenant_id, design_id, file_id),
  CONSTRAINT design_photo_design_fk FOREIGN KEY (tenant_id, design_id) REFERENCES masters.design(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT design_photo_file_fk   FOREIGN KEY (tenant_id, file_id)   REFERENCES platform.file(tenant_id, id)
);
CREATE UNIQUE INDEX design_photo_one_primary ON masters.design_photo (tenant_id, design_id) WHERE is_primary;

-- ---------- version + audit ----------
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON masters.design       FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON masters.design_photo FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
SELECT platform.enable_audit('masters.design');
SELECT platform.enable_audit('masters.design_photo');

-- ---------- RLS (same policies the 960 loops give every masters table) ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['masters.design','masters.design_photo'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = platform.current_tenant()) WITH CHECK (tenant_id = platform.current_tenant())', t);
    EXECUTE format('CREATE POLICY no_partner_access ON %s AS RESTRICTIVE USING (platform.current_partner() IS NULL) WITH CHECK (platform.current_partner() IS NULL)', t);
  END LOOP;
END $$;

-- ---------- grants (masters pattern from 960) ----------
REVOKE ALL ON masters.design, masters.design_photo FROM PUBLIC, app_rw, app_ro, app_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON masters.design, masters.design_photo TO app_rw;    -- masters: removable if unreferenced
GRANT SELECT ON masters.design, masters.design_photo TO app_ro;
GRANT SELECT ON masters.design, masters.design_photo TO sales_writer, inventory_writer, orders_writer, purchases_writer, refinery_writer;
