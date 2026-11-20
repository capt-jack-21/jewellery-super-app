-- 987_inventory_settings_tags.sql — Inventory scope I1–I3 + tag numbering, per-piece photos, shop toggles, permissions
-- (frozen 2026-11-05; Adithya GO 08:40 IST). TEST DB ONLY until Adithya approves a dev redeploy.
-- Reused, not duplicated (080): inventory.tag = one row per physical piece (tag_no = barcode/QR payload, unique per shop;
--   gross/stone/net/cover/loop wt; purity; HUID + hallmark_exempt; mc_type/mc_value/wastage + min/max guardrails; cost_value;
--   counter_id/box_id location; status), inventory.tag_stone (stones per piece), inventory.lot / lot_line (receipt + tagging
--   progress tagged_pieces/tagged_gross_wt), purchases.purchase.lot_id (purchase -> lot), masters.counter / masters.box (box = tray),
--   masters.design (976), masters.value_addition_rule (978), platform.file (974), platform.doc_counter style (100).
-- No new DB functions or triggers: only aa_version (platform.bump_version) and zz_audit (platform.enable_audit).
-- Status transitions, approvals and tag-number generation are done by the app.

-- ---------- 1. per-shop inventory settings: one row per shop; no row = the column defaults ----------
CREATE TABLE inventory.shop_setting (
  tenant_id            uuid NOT NULL REFERENCES platform.tenant(id),
  id                   uuid NOT NULL DEFAULT platform.uuid_v7(),
  -- tag number = prefix [sep segment]... sep zero-padded number, e.g. 'T000123', 'CBE-RNG-000123'. Rendered by the app at
  -- creation and stored in inventory.tag.tag_no; never recomputed, so a format change affects new tags only.
  tag_prefix           varchar(8) NOT NULL DEFAULT 'T' CONSTRAINT shop_setting_tag_prefix_check CHECK (tag_prefix ~ '^[A-Z0-9]{0,8}$'),
  tag_separator        varchar(1) NOT NULL DEFAULT '' CONSTRAINT shop_setting_tag_separator_check CHECK (tag_separator IN ('', '-', '/')),
  tag_branch_segment   boolean NOT NULL DEFAULT false,      -- include platform.branch.code
  tag_item_segment     boolean NOT NULL DEFAULT false,      -- include masters.item.code (upper-cased, [A-Z0-9] only)
  tag_segment_order    text NOT NULL DEFAULT 'branch_item' CONSTRAINT shop_setting_tag_segment_order_check CHECK (tag_segment_order IN ('branch_item','item_branch')),
  tag_start_no         bigint NOT NULL DEFAULT 1 CONSTRAINT shop_setting_tag_start_no_check CHECK (tag_start_no BETWEEN 1 AND 999999999999),
  tag_digits           smallint NOT NULL DEFAULT 6 CONSTRAINT shop_setting_tag_digits_check CHECK (tag_digits BETWEEN 1 AND 12),
  -- transfer / adjustment numbers: rendered by the app at creation and stored in stock_transfer.transfer_no /
  -- stock_adjustment.adjustment_no (never recomputed). Tokens: {BRANCH} = platform.branch.code, {FY} = '2627' (fixed 4-digit FY, e.g. FY 2026-27),
  -- {SEQ:n} = next number zero-padded to n digits. Counter: platform.doc_counter (tenant, branch, doc_type, fy) with
  -- doc_type 'stock_transfer' / 'stock_adjustment' (UPDATE ... RETURNING, gaps allowed); no new counter table.
  transfer_no_format   text NOT NULL DEFAULT 'TRF-{BRANCH}-{FY}-{SEQ:5}'
                       CONSTRAINT shop_setting_transfer_no_format_check CHECK (char_length(transfer_no_format) BETWEEN 1 AND 64 AND transfer_no_format ~ '\{SEQ(:[1-9][0-9]?)?\}'),
  adjustment_no_format text NOT NULL DEFAULT 'ADJ-{BRANCH}-{FY}-{SEQ:5}'
                       CONSTRAINT shop_setting_adjustment_no_format_check CHECK (char_length(adjustment_no_format) BETWEEN 1 AND 64 AND adjustment_no_format ~ '\{SEQ(:[1-9][0-9]?)?\}'),
  -- I10 stock adjustments: who may approve (owner only, or owner or manager)
  adjustment_approver  text NOT NULL DEFAULT 'owner_or_manager' CONSTRAINT shop_setting_adjustment_approver_check CHECK (adjustment_approver IN ('owner_or_manager','owner_only')),
  -- optional features (off by default)
  photos_enabled       boolean NOT NULL DEFAULT false,      -- per-piece photos (inventory.tag_photo)
  ageing_enabled       boolean NOT NULL DEFAULT false,      -- inventory.v_tag_ageing returns rows only when true
  ageing_bucket_days   int[] NOT NULL DEFAULT '{30,90,180,365}'
                       CONSTRAINT shop_setting_ageing_buckets_check CHECK (array_ndims(ageing_bucket_days) = 1 AND cardinality(ageing_bucket_days) BETWEEN 1 AND 8
                         AND array_position(ageing_bucket_days, NULL) IS NULL AND 1 <= ALL (ageing_bucket_days) AND 3650 >= ALL (ageing_bucket_days)),
  updated_by           uuid,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  version              int NOT NULL DEFAULT 1,
  CONSTRAINT shop_setting_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT shop_setting_one_per_shop UNIQUE (tenant_id),
  CONSTRAINT shop_setting_tag_start_fits CHECK (tag_start_no < power(10::numeric, tag_digits)),
  CONSTRAINT shop_setting_updated_by_fk FOREIGN KEY (tenant_id, updated_by) REFERENCES platform.app_user(tenant_id, id)
);
COMMENT ON TABLE inventory.shop_setting IS 'Inventory settings, one row per shop (no row = defaults). Only inventory.settings.edit (owner) may change it; enforced by the app.';
COMMENT ON COLUMN inventory.shop_setting.ageing_bucket_days IS 'bucket lower bounds in days; the ageing view sorts and de-duplicates them. {30,90,180,365} = 0-29, 30-89, 90-179, 180-364, 365+';

-- ---------- 2. tag number counter (doc_counter style: plain row, UPDATE ... RETURNING; gap-tolerant) ----------
-- scope_key = the rendered non-number part of the tag ('T', 'CBE-RNG-', ...). App flow, one transaction:
--   INSERT ... (tenant, scope_key, next_no = tag_start_no) ON CONFLICT DO NOTHING;
--   UPDATE inventory.tag_counter SET next_no = greatest(next_no, <tag_start_no>) + <n>, updated_at = now()
--     WHERE tenant_id = .. AND scope_key = .. RETURNING next_no - <n>   (first number of the block; row lock serialises)
-- If an INSERT into inventory.tag hits tag_tenant_id_tag_no_key (23505), the number is skipped and the next one used.
CREATE TABLE inventory.tag_counter (
  tenant_id  uuid NOT NULL REFERENCES platform.tenant(id),
  scope_key  varchar(40) NOT NULL CONSTRAINT tag_counter_scope_key_check CHECK (scope_key ~ '^[A-Z0-9/-]{0,40}$'),
  next_no    bigint NOT NULL DEFAULT 1 CONSTRAINT tag_counter_next_no_check CHECK (next_no >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tag_counter_pkey PRIMARY KEY (tenant_id, scope_key)
);
COMMENT ON TABLE inventory.tag_counter IS 'next tag number per shop + rendered prefix (scope_key); like platform.doc_counter: no version/audit, gaps allowed';

-- ---------- 3. inventory.tag: piece attributes, label, RFID room, versioning, wider status ----------
-- New stored statuses (existing ones kept; ''in_stock'' is the code shown as "Available"):
--   repair = piece out at the workshop; melting = piece sent to melting/refinery, not yet melted.
--   written_off = TERMINAL: the piece is gone from stock (lost / destroyed). The app sets it ONLY when applying an approved
--   stock_adjustment of kind 'full_write_off' for that tag (988), and never moves a written_off tag to any other status.
--   No trigger enforces this (app logic lives in the app); the DB holds the value, and 988 guards the adjustment side.
-- Full list after 987 (exactly): in_stock, reserved, sold, on_approval, repair, melting, in_transit, returned_to_vendor, melted, written_off.
-- Terminal (not stock): sold, melted, returned_to_vendor, written_off.
ALTER TABLE inventory.tag DROP CONSTRAINT tag_status_check;
ALTER TABLE inventory.tag ADD CONSTRAINT tag_status_check CHECK (status IN ('in_stock','reserved','sold','on_approval','repair','melting',
  'in_transit','returned_to_vendor','melted','written_off'));
ALTER TABLE inventory.tag
  ADD COLUMN design_id              uuid,
  ADD COLUMN hsn                    varchar(8) CONSTRAINT tag_hsn_check CHECK (hsn ~ '^[0-9]{4,8}$'),   -- NULL = sub_item/item HSN
  ADD COLUMN value_addition_rule_id uuid,                -- VA rule the making/wastage defaults came from (informational)
  ADD COLUMN received_on            date,                -- stock-in date for ageing; NULL = age from the tag's creation (tagged_at) IST date
  ADD COLUMN label_payload          text CONSTRAINT tag_label_payload_check CHECK (char_length(label_payload) BETWEEN 1 AND 512),  -- QR text if not tag_no
  ADD COLUMN label_printed_at       timestamptz,
  ADD COLUMN label_print_count      int NOT NULL DEFAULT 0 CONSTRAINT tag_label_print_count_check CHECK (label_print_count >= 0),
  ADD COLUMN rfid_epc               varchar(32) CONSTRAINT tag_rfid_epc_check CHECK (rfid_epc ~ '^[0-9A-F]{8,32}$'),  -- room for RFID (not built)
  ADD COLUMN vendor_lot_ref         text CONSTRAINT tag_vendor_lot_ref_check CHECK (char_length(vendor_lot_ref) BETWEEN 1 AND 60),  -- supplier's lot / batch reference (optional)
  ADD COLUMN version                int NOT NULL DEFAULT 1,
  ADD CONSTRAINT tag_design_fk FOREIGN KEY (tenant_id, design_id) REFERENCES masters.design(tenant_id, id),
  ADD CONSTRAINT tag_value_addition_rule_fk FOREIGN KEY (tenant_id, value_addition_rule_id) REFERENCES masters.value_addition_rule(tenant_id, id),
  ADD CONSTRAINT tag_pieces_check CHECK (pieces >= 1) NOT VALID,
  ADD CONSTRAINT tag_stone_le_gross CHECK (stone_wt <= gross_wt) NOT VALID;
CREATE UNIQUE INDEX tag_rfid_epc_uq ON inventory.tag (tenant_id, rfid_epc) WHERE rfid_epc IS NOT NULL;
CREATE INDEX tag_location_idx ON inventory.tag (tenant_id, branch_id, counter_id, box_id) WHERE status NOT IN ('sold','melted','returned_to_vendor','written_off');
CREATE INDEX tag_design_idx ON inventory.tag (tenant_id, design_id) WHERE design_id IS NOT NULL;
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON inventory.tag FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
COMMENT ON COLUMN inventory.tag.tag_no IS 'rendered tag number (barcode/QR payload), unique per shop, stored at creation and never recomputed; max 30 chars';
COMMENT ON COLUMN inventory.tag.rfid_epc IS 'reserved for RFID (EPC hex, unique per shop); not used yet';

-- ---------- 4. per-piece photos (copy of masters.design_photo; shown only when shop_setting.photos_enabled) ----------
CREATE TABLE inventory.tag_photo (
  tenant_id   uuid NOT NULL REFERENCES platform.tenant(id),
  id          uuid NOT NULL DEFAULT platform.uuid_v7(),
  tag_id      uuid NOT NULL,
  file_id     uuid NOT NULL,                               -- platform.file (area 'attachments')
  sort_order  int NOT NULL DEFAULT 0 CONSTRAINT tag_photo_sort_order_check CHECK (sort_order >= 0),
  is_primary  boolean NOT NULL DEFAULT false,
  caption     text CONSTRAINT tag_photo_caption_check CHECK (caption IS NULL OR char_length(caption) <= 200),
  created_by  uuid,
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tag_photo_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT tag_photo_file_uq UNIQUE (tenant_id, tag_id, file_id),
  CONSTRAINT tag_photo_tag_fk  FOREIGN KEY (tenant_id, tag_id)  REFERENCES inventory.tag(tenant_id, id),
  CONSTRAINT tag_photo_file_fk FOREIGN KEY (tenant_id, file_id) REFERENCES platform.file(tenant_id, id),
  CONSTRAINT tag_photo_created_by_fk FOREIGN KEY (tenant_id, created_by) REFERENCES platform.app_user(tenant_id, id)
);
CREATE UNIQUE INDEX tag_photo_one_primary ON inventory.tag_photo (tenant_id, tag_id) WHERE is_primary;

-- ---------- 5. lot / lot_line (bulk tagging from a purchase) ----------
ALTER TABLE inventory.lot
  ADD COLUMN created_by uuid,
  ADD COLUMN version int NOT NULL DEFAULT 1,
  ADD CONSTRAINT lot_created_by_fk FOREIGN KEY (tenant_id, created_by) REFERENCES platform.app_user(tenant_id, id);
ALTER TABLE inventory.lot_line
  ADD COLUMN purchase_line_id uuid,                        -- the purchase line this lot line came from
  ADD COLUMN purity_id uuid,                               -- default purity for the pieces tagged from this line
  ADD COLUMN version int NOT NULL DEFAULT 1,
  ADD CONSTRAINT lot_line_purchase_line_fk FOREIGN KEY (tenant_id, purchase_line_id) REFERENCES purchases.purchase_line(tenant_id, id),
  ADD CONSTRAINT lot_line_purity_fk FOREIGN KEY (tenant_id, purity_id) REFERENCES masters.purity(tenant_id, id),
  ADD CONSTRAINT lot_line_tagged_check CHECK (tagged_pieces >= 0) NOT VALID;
CREATE INDEX lot_line_lot_idx ON inventory.lot_line (tenant_id, lot_id);
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON inventory.lot      FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON inventory.lot_line FOR EACH ROW EXECUTE FUNCTION platform.bump_version();

-- ---------- 6. version + audit on the new tables ----------
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON inventory.shop_setting FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON inventory.tag_photo    FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
SELECT platform.enable_audit('inventory.shop_setting');
SELECT platform.enable_audit('inventory.tag_photo');
SELECT platform.enable_audit('inventory.lot');
SELECT platform.enable_audit('inventory.lot_line');

-- ---------- 7. RLS (960 pattern; tag_counter/shop_setting/tag_photo carry no branch_id) ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inventory.shop_setting','inventory.tag_counter','inventory.tag_photo'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = platform.current_tenant()) WITH CHECK (tenant_id = platform.current_tenant())', t);
    EXECUTE format('CREATE POLICY no_partner_access ON %s AS RESTRICTIVE USING (platform.current_partner() IS NULL) WITH CHECK (platform.current_partner() IS NULL)', t);
  END LOOP;
END $$;

-- ---------- 8. grants (960 inventory pattern) ----------
REVOKE ALL ON inventory.shop_setting, inventory.tag_counter, inventory.tag_photo FROM PUBLIC, app_rw, app_ro, app_worker;
GRANT SELECT, INSERT, UPDATE ON inventory.shop_setting, inventory.tag_counter TO app_rw;     -- no DELETE
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.tag_photo TO app_rw;                       -- photos removable
GRANT SELECT ON inventory.shop_setting, inventory.tag_counter, inventory.tag_photo TO app_ro;
GRANT SELECT ON inventory.shop_setting, inventory.tag_counter, inventory.tag_photo TO sales_writer, inventory_writer, orders_writer, purchases_writer, refinery_writer;
-- tag: descriptive/label columns editable by app_rw (status/branch_id stay inventory_writer-only; tag_no/weights never via app_rw)
GRANT UPDATE (design_id, hsn, value_addition_rule_id, received_on, label_payload, label_printed_at, label_print_count, vendor_lot_ref) ON inventory.tag TO app_rw;
-- an APPROVED stock adjustment (988) changes a piece's weights/pieces through the inventory module role, with a ledger row
GRANT UPDATE (gross_wt, net_wt, stone_wt, pieces) ON inventory.tag TO inventory_writer;

-- lot_line DELETE (undo a wrong receipt line): app_rw only, and only while the parent lot is not closed
-- (lot status 'open' or 'tagged') and the line has no tags yet (tagged_pieces = 0 and no inventory.tag.lot_line_id
-- points at it). Enforced by the RESTRICTIVE policy below (no trigger/function); rows outside it are silently filtered
-- (DELETE affects 0 rows). The EXISTS subqueries run under the caller's RLS, so tenant_isolation and the lot's
-- branch_scope still apply. Deletes are audited by zz_audit (AFTER INSERT OR UPDATE OR DELETE, enabled above).
-- The tag -> lot_line FK (080) stays as a backstop for a tag the caller cannot see.
GRANT DELETE ON inventory.lot_line TO app_rw;
CREATE POLICY rw_delete_open_lot_only ON inventory.lot_line AS RESTRICTIVE FOR DELETE TO app_rw
  USING (tagged_pieces = 0
         AND EXISTS (SELECT 1 FROM inventory.lot l
                     WHERE l.tenant_id = lot_line.tenant_id AND l.id = lot_line.lot_id AND l.status IN ('open','tagged'))
         AND NOT EXISTS (SELECT 1 FROM inventory.tag t WHERE t.tenant_id = lot_line.tenant_id AND t.lot_line_id = lot_line.id));
CREATE INDEX tag_lot_line_idx ON inventory.tag (tenant_id, lot_line_id) WHERE lot_line_id IS NOT NULL;

-- ---------- 9. inventory.* permissions (global catalogue; 982 pattern) ----------
INSERT INTO platform.permission(code, module, description) VALUES
 ('inventory.stock.view',            'inventory', 'View stock, tags and locations'),
 ('inventory.tag.create',            'inventory', 'Create tags (single and bulk from a lot)'),
 ('inventory.tag.edit',              'inventory', 'Edit tag details (not weights)'),
 ('inventory.tag.print_label',       'inventory', 'Print / reprint tag labels'),
 ('inventory.tag.photos',            'inventory', 'Add or remove piece photos'),
 ('inventory.tag.status_change',     'inventory', 'Move a piece to repair / melting / back to stock (not written_off: only via an approved full write-off)'),
 ('inventory.move',                  'inventory', 'Move stock between counters and trays'),
 ('inventory.transfer.dispatch',     'inventory', 'Dispatch a branch transfer'),
 ('inventory.transfer.receive',      'inventory', 'Confirm receipt of a branch transfer'),
 ('inventory.stock_check.run',       'inventory', 'Scan pieces in a stock check'),
 ('inventory.stock_check.close',     'inventory', 'Start, close or cancel a stock check'),
 ('inventory.adjustment.request',    'inventory', 'Request a stock adjustment'),
 ('inventory.adjustment.approve',    'inventory', 'Approve or reject a stock adjustment'),
 ('inventory.valuation.view',        'inventory', 'View stock valuation'),
 ('inventory.ageing.view',           'inventory', 'View stock ageing'),
 ('inventory.settings.edit',         'inventory', 'Change inventory settings (tag format, approvals, photos, ageing)');
INSERT INTO platform.system_role_permission(role_code, permission_code)
SELECT r.code, p.code FROM platform.permission p
CROSS JOIN (VALUES ('owner'), ('manager'), ('salesperson'), ('cashier')) AS r(code)
WHERE p.code IN ('inventory.stock.view','inventory.tag.create','inventory.tag.edit','inventory.tag.print_label','inventory.tag.photos',
                 'inventory.tag.status_change','inventory.move','inventory.transfer.dispatch','inventory.transfer.receive',
                 'inventory.stock_check.run','inventory.stock_check.close','inventory.adjustment.request','inventory.adjustment.approve',
                 'inventory.valuation.view','inventory.ageing.view','inventory.settings.edit')
  AND (r.code = 'owner'
       OR (r.code = 'manager' AND p.code <> 'inventory.settings.edit')
       OR (r.code = 'salesperson' AND p.code IN ('inventory.stock.view','inventory.tag.print_label','inventory.stock_check.run','inventory.move'))
       OR (r.code = 'cashier' AND p.code = 'inventory.stock.view'));
