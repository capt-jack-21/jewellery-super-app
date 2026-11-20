-- 988_inventory_movements.sql — Inventory scope I4, I6, I7, I8 (scans), I10: loose-stock location, counter/tray moves,
-- branch transfers, stock checks, stock adjustments with approval. TEST DB ONLY until Adithya approves a dev redeploy.
-- Reused (080): inventory.stock_ledger (append-only; only inventory_writer inserts; loose/non-tag stock = rows with tag_id NULL),
--   inventory.stock_transfer / stock_transfer_line (draft -> approved -> in_transit -> received | returned | cancelled),
--   inventory.stock_take (stock check session). No new DB functions or triggers beyond aa_version and zz_audit.

-- ---------- 1. stock_ledger: counter/tray of the movement + counter/tray move movements (I4/I7) ----------
ALTER TABLE inventory.stock_ledger DROP CONSTRAINT stock_ledger_movement_check;
ALTER TABLE inventory.stock_ledger ADD CONSTRAINT stock_ledger_movement_check CHECK (movement IN ('tagged','opening','sale','sales_return',
  'cancel_reversal','transfer_out','transfer_in','approval_out','approval_in','purchase_in','purchase_return','old_metal_in','melt_out',
  'refinery_in','adjustment','non_tag_in','non_tag_out','move_out','move_in'));
ALTER TABLE inventory.stock_ledger
  ADD COLUMN counter_id uuid,                -- where the stock is/was within the branch (NULL = branch level, not on a counter)
  ADD COLUMN box_id uuid,
  ADD CONSTRAINT stock_ledger_counter_fk FOREIGN KEY (tenant_id, counter_id) REFERENCES masters.counter(tenant_id, id),
  ADD CONSTRAINT stock_ledger_box_fk FOREIGN KEY (tenant_id, box_id) REFERENCES masters.box(tenant_id, id);
CREATE INDEX stock_ledger_loose_idx ON inventory.stock_ledger (tenant_id, branch_id, item_id, purity_id) WHERE tag_id IS NULL;

-- ---------- 2. counter / tray moves within a branch (I7): insert-only history ----------
-- Tagged piece: the app updates tag.counter_id/box_id (app_rw column grant from 960) and inserts one row here.
-- Loose stock: one row here + a move_out/move_in stock_ledger pair (inventory_writer) carrying the counters/trays.
CREATE TABLE inventory.location_move (
  tenant_id        uuid NOT NULL REFERENCES platform.tenant(id),
  id               uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id        uuid NOT NULL,
  tag_id           uuid,                                    -- tagged piece, or NULL for loose stock
  item_id          uuid, purity_id uuid,                    -- loose stock
  pieces           int NOT NULL DEFAULT 0 CONSTRAINT location_move_pieces_check CHECK (pieces >= 0),
  gross_wt         platform.weight_g NOT NULL DEFAULT 0,
  net_wt           platform.weight_g NOT NULL DEFAULT 0,
  from_counter_id  uuid, from_box_id uuid,                  -- NULL = not on a counter
  to_counter_id    uuid, to_box_id uuid,
  reason           text CONSTRAINT location_move_reason_check CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 300),
  moved_by         uuid NOT NULL,
  moved_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT location_move_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT location_move_what CHECK (tag_id IS NOT NULL OR (item_id IS NOT NULL AND purity_id IS NOT NULL AND (pieces > 0 OR gross_wt > 0))),
  CONSTRAINT location_move_net_le_gross CHECK (net_wt <= gross_wt),
  CONSTRAINT location_move_changes CHECK ((from_counter_id, from_box_id) IS DISTINCT FROM (to_counter_id, to_box_id)),
  CONSTRAINT location_move_box_needs_counter CHECK ((from_box_id IS NULL OR from_counter_id IS NOT NULL) AND (to_box_id IS NULL OR to_counter_id IS NOT NULL)),
  CONSTRAINT location_move_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id),
  CONSTRAINT location_move_tag_fk FOREIGN KEY (tenant_id, tag_id) REFERENCES inventory.tag(tenant_id, id),
  CONSTRAINT location_move_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES masters.item(tenant_id, id),
  CONSTRAINT location_move_purity_fk FOREIGN KEY (tenant_id, purity_id) REFERENCES masters.purity(tenant_id, id),
  CONSTRAINT location_move_from_counter_fk FOREIGN KEY (tenant_id, from_counter_id) REFERENCES masters.counter(tenant_id, id),
  CONSTRAINT location_move_from_box_fk FOREIGN KEY (tenant_id, from_box_id) REFERENCES masters.box(tenant_id, id),
  CONSTRAINT location_move_to_counter_fk FOREIGN KEY (tenant_id, to_counter_id) REFERENCES masters.counter(tenant_id, id),
  CONSTRAINT location_move_to_box_fk FOREIGN KEY (tenant_id, to_box_id) REFERENCES masters.box(tenant_id, id),
  CONSTRAINT location_move_moved_by_fk FOREIGN KEY (tenant_id, moved_by) REFERENCES platform.app_user(tenant_id, id)
);
CREATE INDEX location_move_tag_idx ON inventory.location_move (tenant_id, tag_id, moved_at) WHERE tag_id IS NOT NULL;
CREATE INDEX location_move_branch_idx ON inventory.location_move (tenant_id, branch_id, moved_at);

-- ---------- 3. branch transfers (I6): who dispatched / received / cancelled, and state guards ----------
-- Flow (app): draft -> approved (inventory.transfer.approve) -> in_transit (dispatch: tags status 'in_transit', transfer_out
-- ledger rows) -> received (receiving branch confirms: tags in_stock at to_branch, transfer_in rows) | returned | cancelled.
ALTER TABLE inventory.stock_transfer
  ADD COLUMN dispatched_by uuid,
  ADD COLUMN cancelled_by uuid,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN remarks text CONSTRAINT stock_transfer_remarks_check CHECK (remarks IS NULL OR char_length(remarks) <= 500),
  ADD COLUMN version int NOT NULL DEFAULT 1,
  ADD CONSTRAINT stock_transfer_dispatched_chk CHECK (status NOT IN ('in_transit','received','returned') OR (dispatched_at IS NOT NULL AND dispatched_by IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT stock_transfer_received_chk CHECK (status <> 'received' OR (received_at IS NOT NULL AND received_by IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT stock_transfer_approved_chk CHECK (status IN ('draft','cancelled') OR approved_by IS NOT NULL) NOT VALID,
  ADD CONSTRAINT stock_transfer_cancelled_chk CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL) NOT VALID,
  ADD CONSTRAINT stock_transfer_received_after_dispatch CHECK (received_at IS NULL OR dispatched_at IS NULL OR received_at >= dispatched_at) NOT VALID,
  ADD CONSTRAINT stock_transfer_requested_by_fk FOREIGN KEY (tenant_id, requested_by) REFERENCES platform.app_user(tenant_id, id) NOT VALID,
  ADD CONSTRAINT stock_transfer_approved_by_fk FOREIGN KEY (tenant_id, approved_by) REFERENCES platform.app_user(tenant_id, id) NOT VALID,
  ADD CONSTRAINT stock_transfer_dispatched_by_fk FOREIGN KEY (tenant_id, dispatched_by) REFERENCES platform.app_user(tenant_id, id),
  ADD CONSTRAINT stock_transfer_received_by_fk FOREIGN KEY (tenant_id, received_by) REFERENCES platform.app_user(tenant_id, id) NOT VALID,
  ADD CONSTRAINT stock_transfer_cancelled_by_fk FOREIGN KEY (tenant_id, cancelled_by) REFERENCES platform.app_user(tenant_id, id);
CREATE INDEX stock_transfer_to_idx ON inventory.stock_transfer (tenant_id, to_branch_id, status);
CREATE INDEX stock_transfer_from_idx ON inventory.stock_transfer (tenant_id, from_branch_id, status);
ALTER TABLE inventory.stock_transfer_line
  ADD COLUMN received_at timestamptz,
  ADD COLUMN received_by uuid,
  ADD COLUMN version int NOT NULL DEFAULT 1,
  -- loose stock picked from a counter / tray at the sending branch (NULL = not recorded; tagged lines use the tag's location)
  ADD COLUMN from_counter_id uuid,
  ADD COLUMN from_box_id uuid,
  ADD CONSTRAINT stock_transfer_line_box_needs_counter CHECK (from_box_id IS NULL OR from_counter_id IS NOT NULL),
  ADD CONSTRAINT stock_transfer_line_from_counter_fk FOREIGN KEY (tenant_id, from_counter_id) REFERENCES masters.counter(tenant_id, id),
  ADD CONSTRAINT stock_transfer_line_from_box_fk FOREIGN KEY (tenant_id, from_box_id) REFERENCES masters.box(tenant_id, id),
  ADD CONSTRAINT stock_transfer_line_received_chk CHECK (NOT received OR received_at IS NOT NULL) NOT VALID,
  ADD CONSTRAINT stock_transfer_line_what CHECK (tag_id IS NOT NULL OR (item_id IS NOT NULL AND purity_id IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT stock_transfer_line_received_by_fk FOREIGN KEY (tenant_id, received_by) REFERENCES platform.app_user(tenant_id, id);
CREATE INDEX stock_transfer_line_transfer_idx ON inventory.stock_transfer_line (tenant_id, transfer_id);
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON inventory.stock_transfer      FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON inventory.stock_transfer_line FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
SELECT platform.enable_audit('inventory.stock_transfer_line');
-- branch sub-scope: a transfer has no branch_id; a branch-scoped session sees it if either end is in scope
CREATE POLICY branch_scope ON inventory.stock_transfer AS RESTRICTIVE
  USING (coalesce(current_setting('app.branch_scope', true), '') = ''
         OR from_branch_id::text = ANY (string_to_array(current_setting('app.branch_scope', true), ','))
         OR to_branch_id::text = ANY (string_to_array(current_setting('app.branch_scope', true), ',')));

-- ---------- 4. stock check (I8): scope, who, and one row per scan ----------
ALTER TABLE inventory.stock_take DROP CONSTRAINT stock_take_status_check;
ALTER TABLE inventory.stock_take ADD CONSTRAINT stock_take_status_check CHECK (status IN ('open','closed','cancelled'));
ALTER TABLE inventory.stock_take
  ADD COLUMN counter_id uuid,               -- NULL = whole branch
  ADD COLUMN box_id uuid,                   -- NULL = whole counter (or branch)
  ADD COLUMN started_by uuid,
  ADD COLUMN closed_by uuid,
  ADD COLUMN notes text CONSTRAINT stock_take_notes_check CHECK (notes IS NULL OR char_length(notes) <= 500),
  ADD COLUMN version int NOT NULL DEFAULT 1,
  ADD CONSTRAINT stock_take_closed_chk CHECK (status = 'open' OR closed_at IS NOT NULL) NOT VALID,
  ADD CONSTRAINT stock_take_box_needs_counter CHECK (box_id IS NULL OR counter_id IS NOT NULL),
  ADD CONSTRAINT stock_take_counter_fk FOREIGN KEY (tenant_id, counter_id) REFERENCES masters.counter(tenant_id, id),
  ADD CONSTRAINT stock_take_box_fk FOREIGN KEY (tenant_id, box_id) REFERENCES masters.box(tenant_id, id),
  ADD CONSTRAINT stock_take_started_by_fk FOREIGN KEY (tenant_id, started_by) REFERENCES platform.app_user(tenant_id, id),
  ADD CONSTRAINT stock_take_closed_by_fk FOREIGN KEY (tenant_id, closed_by) REFERENCES platform.app_user(tenant_id, id);
COMMENT ON COLUMN inventory.stock_take.scanned_tag_ids IS 'DEPRECATED (988): scans are rows in inventory.stock_take_scan; leave empty';
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON inventory.stock_take FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
SELECT platform.enable_audit('inventory.stock_take');

CREATE TABLE inventory.stock_take_scan (
  tenant_id      uuid NOT NULL REFERENCES platform.tenant(id),
  id             uuid NOT NULL DEFAULT platform.uuid_v7(),
  stock_take_id  uuid NOT NULL,
  scanned_code   varchar(64) NOT NULL CONSTRAINT stock_take_scan_code_check CHECK (char_length(scanned_code) BETWEEN 1 AND 64),
  tag_id         uuid,                      -- resolved by the app (tag_no / RFID / HUID); NULL = unknown code (reported as extra)
  scanned_by     uuid,
  scanned_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_take_scan_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT stock_take_scan_code_uq UNIQUE (tenant_id, stock_take_id, scanned_code),
  CONSTRAINT stock_take_scan_take_fk FOREIGN KEY (tenant_id, stock_take_id) REFERENCES inventory.stock_take(tenant_id, id),
  CONSTRAINT stock_take_scan_tag_fk FOREIGN KEY (tenant_id, tag_id) REFERENCES inventory.tag(tenant_id, id),
  CONSTRAINT stock_take_scan_by_fk FOREIGN KEY (tenant_id, scanned_by) REFERENCES platform.app_user(tenant_id, id)
);
CREATE UNIQUE INDEX stock_take_scan_tag_uq ON inventory.stock_take_scan (tenant_id, stock_take_id, tag_id) WHERE tag_id IS NOT NULL;
COMMENT ON TABLE inventory.stock_take_scan IS 'one row per scanned code in a stock check; a re-scan of the same code is a unique violation (app ignores it); no audit (volume)';

-- ---------- 5. stock adjustments with approval (I10) ----------
-- The app checks the approver against inventory.shop_setting.adjustment_approver (owner_only / owner_or_manager) and
-- inventory.adjustment.approve, then (approved) writes an 'adjustment' stock_ledger row and, for a tag, its new weights/pieces
-- through inventory_writer. The DB stores the request, the decision, who decided, in which role, and when.
CREATE TABLE inventory.stock_adjustment (
  tenant_id        uuid NOT NULL REFERENCES platform.tenant(id),
  id               uuid NOT NULL DEFAULT platform.uuid_v7(),
  branch_id        uuid NOT NULL,
  adjustment_no    text,                                    -- doc number, unique per shop; NULL until numbered (shop_setting.adjustment_no_format, platform.doc_counter doc_type 'stock_adjustment')
  kind             text NOT NULL CONSTRAINT stock_adjustment_kind_check CHECK (kind IN ('weight_loss','weight_gain','piece_loss','piece_gain','write_off','full_write_off','correction')),
  tag_id           uuid,                                    -- a tagged piece, or NULL for loose stock (item + purity)
  item_id          uuid, purity_id uuid,
  counter_id       uuid, box_id uuid,
  delta_pieces     int NOT NULL DEFAULT 0,
  delta_gross_wt   numeric(12,3) NOT NULL DEFAULT 0,         -- signed grams
  delta_net_wt     numeric(12,3) NOT NULL DEFAULT 0,
  reason_code      text NOT NULL CONSTRAINT stock_adjustment_reason_code_check CHECK (reason_code IN ('polishing','repair','breakage','loss','count_error','weighing_error','melting_loss','other')),
  reason           text NOT NULL CONSTRAINT stock_adjustment_reason_check CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  status           text NOT NULL DEFAULT 'pending' CONSTRAINT stock_adjustment_status_check CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by     uuid NOT NULL,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  decided_by       uuid,
  decided_as_role  text CONSTRAINT stock_adjustment_decided_as_role_check CHECK (decided_as_role IN ('owner','manager')),
  decided_at       timestamptz,
  decision_note    text CONSTRAINT stock_adjustment_decision_note_check CHECK (decision_note IS NULL OR char_length(decision_note) <= 500),
  approval_request_id uuid,                                  -- optional link to approvals.request (generic approval queue)
  version          int NOT NULL DEFAULT 1,
  CONSTRAINT stock_adjustment_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT stock_adjustment_no_uq UNIQUE (tenant_id, adjustment_no),
  CONSTRAINT stock_adjustment_what CHECK (tag_id IS NOT NULL OR (item_id IS NOT NULL AND purity_id IS NOT NULL)),
  CONSTRAINT stock_adjustment_nonzero CHECK (delta_pieces <> 0 OR delta_gross_wt <> 0 OR delta_net_wt <> 0),
  CONSTRAINT stock_adjustment_sign CHECK (
       (kind <> 'weight_loss' OR (delta_gross_wt < 0 AND delta_net_wt <= 0))
   AND (kind <> 'weight_gain' OR (delta_gross_wt > 0 AND delta_net_wt >= 0))
   AND (kind <> 'piece_loss'  OR delta_pieces < 0)
   AND (kind <> 'piece_gain'  OR delta_pieces > 0)
   AND (kind <> 'write_off'   OR (delta_pieces <= 0 AND delta_gross_wt <= 0 AND delta_net_wt <= 0))
   AND (kind <> 'full_write_off' OR (delta_pieces < 0 AND delta_gross_wt < 0 AND delta_net_wt <= 0))),
  -- full_write_off = the whole tagged piece leaves stock; once approved the app sets the tag's status to 'written_off' (terminal).
  -- The deltas must equal the tag's full pieces/weights (minus); the app checks that against the tag (cross-row, no trigger).
  CONSTRAINT stock_adjustment_full_write_off_tag CHECK (kind <> 'full_write_off' OR tag_id IS NOT NULL),
  CONSTRAINT stock_adjustment_decision CHECK (CASE WHEN status IN ('approved','rejected')
       THEN decided_by IS NOT NULL AND decided_at IS NOT NULL AND decided_as_role IS NOT NULL
       ELSE decided_by IS NULL AND decided_at IS NULL AND decided_as_role IS NULL END),
  CONSTRAINT stock_adjustment_decided_after CHECK (decided_at IS NULL OR decided_at >= requested_at),
  CONSTRAINT stock_adjustment_box_needs_counter CHECK (box_id IS NULL OR counter_id IS NOT NULL),
  CONSTRAINT stock_adjustment_branch_fk FOREIGN KEY (tenant_id, branch_id) REFERENCES platform.branch(tenant_id, id),
  CONSTRAINT stock_adjustment_tag_fk FOREIGN KEY (tenant_id, tag_id) REFERENCES inventory.tag(tenant_id, id),
  CONSTRAINT stock_adjustment_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES masters.item(tenant_id, id),
  CONSTRAINT stock_adjustment_purity_fk FOREIGN KEY (tenant_id, purity_id) REFERENCES masters.purity(tenant_id, id),
  CONSTRAINT stock_adjustment_counter_fk FOREIGN KEY (tenant_id, counter_id) REFERENCES masters.counter(tenant_id, id),
  CONSTRAINT stock_adjustment_box_fk FOREIGN KEY (tenant_id, box_id) REFERENCES masters.box(tenant_id, id),
  CONSTRAINT stock_adjustment_requested_by_fk FOREIGN KEY (tenant_id, requested_by) REFERENCES platform.app_user(tenant_id, id),
  CONSTRAINT stock_adjustment_decided_by_fk FOREIGN KEY (tenant_id, decided_by) REFERENCES platform.app_user(tenant_id, id),
  CONSTRAINT stock_adjustment_approval_request_fk FOREIGN KEY (tenant_id, approval_request_id) REFERENCES approvals.request(tenant_id, id)
);
CREATE INDEX stock_adjustment_approval_request_idx ON inventory.stock_adjustment (tenant_id, approval_request_id) WHERE approval_request_id IS NOT NULL;
COMMENT ON COLUMN inventory.stock_adjustment.approval_request_id IS
  'Optional approvals.request row when the app routes the adjustment through the approval queue (ref_type ''stock_adjustment''). The decision of record stays in decided_by / decided_as_role / decided_at here. Self-approval: the app allows it only for the owner (decided_as_role = ''owner'', decided_by = requested_by) and audits it as self-approved; the DB does not block it.';
CREATE INDEX stock_adjustment_pending_idx ON inventory.stock_adjustment (tenant_id, branch_id, requested_at) WHERE status = 'pending';
CREATE INDEX stock_adjustment_tag_idx ON inventory.stock_adjustment (tenant_id, tag_id) WHERE tag_id IS NOT NULL;

-- ---------- 6. version + audit ----------
CREATE TRIGGER aa_version BEFORE INSERT OR UPDATE ON inventory.stock_adjustment FOR EACH ROW EXECUTE FUNCTION platform.bump_version();
SELECT platform.enable_audit('inventory.stock_adjustment');
SELECT platform.enable_audit('inventory.location_move');

-- ---------- 7. RLS: tenant_isolation + no_partner_access; branch_scope where the table has branch_id ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inventory.location_move','inventory.stock_take_scan','inventory.stock_adjustment'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = platform.current_tenant()) WITH CHECK (tenant_id = platform.current_tenant())', t);
    EXECUTE format('CREATE POLICY no_partner_access ON %s AS RESTRICTIVE USING (platform.current_partner() IS NULL) WITH CHECK (platform.current_partner() IS NULL)', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['inventory.location_move','inventory.stock_adjustment'] LOOP
    EXECUTE format($p$CREATE POLICY branch_scope ON %s AS RESTRICTIVE
                     USING (coalesce(current_setting('app.branch_scope', true), '') = ''
                            OR branch_id::text = ANY (string_to_array(current_setting('app.branch_scope', true), ',')))$p$, t);
  END LOOP;
END $$;

-- ---------- 8. grants ----------
REVOKE ALL ON inventory.location_move, inventory.stock_take_scan, inventory.stock_adjustment FROM PUBLIC, app_rw, app_ro, app_worker;
GRANT SELECT, INSERT ON inventory.location_move TO app_rw;                     -- history: insert-only
GRANT SELECT, INSERT, DELETE ON inventory.stock_take_scan TO app_rw;           -- DELETE = undo a wrong scan while open
-- stock_transfer_line DELETE (edit a draft): app_rw only, and only while the parent transfer is 'draft'. Once it is
-- approved / in_transit / received / returned / cancelled the RESTRICTIVE policy filters the row (DELETE affects 0 rows).
-- No trigger/function; the EXISTS runs under the caller's RLS (tenant_isolation + the transfer's branch_scope).
-- Deletes are audited by zz_audit (enable_audit above).
GRANT DELETE ON inventory.stock_transfer_line TO app_rw;
CREATE POLICY rw_delete_draft_only ON inventory.stock_transfer_line AS RESTRICTIVE FOR DELETE TO app_rw
  USING (EXISTS (SELECT 1 FROM inventory.stock_transfer s
                 WHERE s.tenant_id = stock_transfer_line.tenant_id AND s.id = stock_transfer_line.transfer_id AND s.status = 'draft'));
GRANT SELECT, INSERT, UPDATE ON inventory.stock_adjustment TO app_rw;          -- never deleted (cancel instead)
GRANT SELECT ON inventory.location_move, inventory.stock_take_scan, inventory.stock_adjustment TO app_ro;
GRANT SELECT ON inventory.location_move, inventory.stock_take_scan, inventory.stock_adjustment TO sales_writer, inventory_writer, orders_writer, purchases_writer, refinery_writer;
