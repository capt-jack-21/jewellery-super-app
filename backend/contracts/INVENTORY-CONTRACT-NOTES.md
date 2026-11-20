# Inventory contract 0.8.4: notes

Status (0.8.4): the module is built (`packages/modules/inventory`, routes wired into apps/api) and tested on the VPS test DB only;
not deployed, and 987-989 are not on dev. Every /v1/inventory operation is served (`x-backing: implemented on 987-989`); the twelve
that answered 501 in 0.8.2 (lots ×5, tag history, photo list / edit, stock-summary, moves list, transfer PATCH, scan list) are built in 0.8.3.
987 re-landed with `tag.vendor_lot_ref` (sha256 84589a5e…, checked in `migrator.schema_migrations`).
Aligned to Perceptor's updated 987-989 on the VPS test DB, 5 Nov 2026 (sha256 987 5a2e8f98…, 988 f58e45fa…, 989 b16a639b…;
checked in `migrator.schema_migrations`). 0.8.1 adds: `value_basis` on valuation, `age_basis` on ageing, the `written_off`
status and `full_write_off` adjustments, server-assigned TRF/ADJ numbers, and salesperson moves (lead decisions of 5 Nov 2026, 09:39 IST).
Lead decisions (2), (4), (5), (6), (7), (9), (12) were given by Ultra Magnus on 5 Nov 2026. Everything else here is Ironhide's decision.

## 1. Conventions (same as Masters)

- **Lists:** `q`, `include_inactive`, `limit` 1-200 (default 50), `cursor`, `ids`. They return `{items, next_cursor}` with keyset paging.
  Inventory documents (transfers, checks, adjustments, moves) take the filters that make sense for them.
- **If-Match** on every edit and decision: a missing header gives 428 and a stale one gives 412 `version_mismatch`. The ETag is the row `version`.
  The one exception is the first save of `/settings` while the shop still has no row.
- **Idempotency-Key** on every create, and on dispatch and receive.
  Stock-check scans are idempotent by code instead (`stock_take_scan` is unique per check).
- **Numbers:** weights are decimal strings with 3 dp, money with 2 dp. Signed deltas use `SignedWeight`.
- **Errors:** problem+json. A 422 carries `errors[].path`. Bulk tagging uses `rows.N.field` (N is zero-based).
- **Branch:** `branch_id` is optional wherever it filters. When it is missing, the server falls back to the `X-Branch-Id` header.
  Branch-scoped users only ever see their own branches.
- **Only Inventory mutates stock.** Tag status, branch, counter or tray, weights and `stock_ledger` change only here.
  Sales, approval memos, Purchases, Refinery and the import call the Inventory service inside their own transaction.
  Weight and pieces columns are written as `inventory_writer` (`SET LOCAL ROLE`); app_rw can't update them.

## 2. Endpoint → table / view map

| Endpoint(s) | Tables / views | Permission |
|---|---|---|
| GET/PATCH `/v1/inventory/settings`, POST `/settings/tag-format/preview` | `shop_setting` (no row means defaults) | view: stock.view; PATCH: **settings.edit** |
| GET `/statuses` | static | stock.view |
| `/lots`, `/lots/{id}`, `/lots/{id}/close` | `lot`, `lot_line`; close with `to_loose` writes ledger `non_tag_in` | tag.create (read: stock.view) |
| `/tags`, `/tags/bulk`, `/tags/bulk-update`, `/tags/{id}`, `/tags/{id}/history` | `tag`, `tag_stone`, `tag_counter`, `lot_line`, ledger `tagged` / `non_tag_out` | create: tag.create; edit: tag.edit; read: stock.view |
| GET `/tag-lookup/{tagNo}` | `tag` by tag_no, label_payload, rfid_epc or huid | stock.view |
| POST `/tags/{id}/status` | `tag.status` (in_stock ↔ reserved, repair, melting) | **tag.status_change** |
| `/tags/{id}/photos[/{photoId}]` | `tag_photo`, `platform.file` (purpose `tag_photo`) | tag.photos (read: stock.view) |
| POST `/labels` | `v_tag_label`; bumps `label_printed_at` / `label_print_count` | tag.print_label |
| GET `/loose-stock`, POST `/loose-stock/receipts` | `v_loose_stock`; ledger `non_tag_in` | read: stock.view; receipt: tag.create |
| GET `/stock-summary` | `v_tag_stock_location` + `v_loose_stock` | stock.view |
| GET `/ledger` | `stock_ledger` | stock.view |
| GET/POST `/moves` | `location_move` + ledger `move_out` / `move_in` pair; updates `tag.counter_id/box_id` | POST: **move** |
| `/transfers…` | `stock_transfer`, `stock_transfer_line`; ledger `transfer_out` / `transfer_in` | create/edit/dispatch/return/cancel: transfer.dispatch; approve: transfer.approve; receive: transfer.receive |
| `/stock-checks…` | `stock_take`, `stock_take_scan`, `v_stock_take_report` | start/close/cancel: stock_check.close; scans/report/read: stock_check.run |
| `/adjustments…` | `stock_adjustment`; on approval, ledger `adjustment` and tag weights | request/cancel: adjustment.request; approve/reject: adjustment.approve + rule; read: stock.view |
| GET `/valuation` | `v_stock_valuation` | valuation.view |
| GET `/reports/ageing` | `v_tag_ageing` (since = COALESCE(tag.received_on, tagged date)); `age_basis` per row | ageing.view |
| Import kind `stock` (existing `/v1/imports`) | via the Inventory service: `lot` (entry_type opening), `tag`, ledger `opening` | platform.import.run + tag.create |

Not in the contract on purpose:

- free-form loose "issue";
- a move document or move_no (`location_move` has none);
- a transfer note print doc_type;
- `/settings/tag-format/tokens`.

## 3. Permissions: the 16 codes from 987

| Code | owner | manager | salesperson | cashier |
|---|---|---|---|---|
| inventory.stock.view | ✓ | ✓ | ✓ | ✓ |
| inventory.tag.create | ✓ | ✓ | | |
| inventory.tag.edit | ✓ | ✓ | | |
| inventory.tag.print_label | ✓ | ✓ | ✓ | |
| inventory.tag.photos | ✓ | ✓ | | |
| inventory.tag.status_change | ✓ | ✓ | | |
| inventory.move | ✓ | ✓ | ✓ (own branch; default per lead decision 3, seed pending — §8) | |
| inventory.transfer.dispatch | ✓ | ✓ | | |
| inventory.transfer.receive | ✓ | ✓ | | |
| inventory.stock_check.run | ✓ | ✓ | ✓ | |
| inventory.stock_check.close | ✓ | ✓ | | |
| inventory.adjustment.request | ✓ | ✓ | | |
| inventory.adjustment.approve | ✓ | ✓ | | |
| inventory.valuation.view | ✓ | ✓ | | |
| inventory.ageing.view | ✓ | ✓ | | |
| inventory.settings.edit | ✓ | | | |

Codes that already exist and are still used:

- `inventory.transfer.approve`: approves a transfer.
- `inventory.tag.view_cost`: needed to see or write `cost_value`.
- `platform.import.run`: runs the opening-stock import.

This replaces the `inventory.<area>.view` / `.manage` naming in the original brief and in Mirage's A0.

## 4. Statuses and transitions (`tag.status`, 987)

Exactly: `in_stock` (shown as "Available"), `reserved`, `sold`, `on_approval`, `repair`, `melting`, `in_transit`, `returned_to_vendor`, `melted`, `written_off`.

- **Terminal (not stock):** sold, melted, returned_to_vendor, written_off. **In stock:** every other status; in-stock pieces are counted and valued. In-stock pieces are counted and valued.
  **Sellable:** in_stock at the requested branch.
- **Through POST `/tags/{id}/status`:** in_stock → reserved, repair or melting, and back to in_stock.
- **Through other modules, via the Inventory service:**
  - Sales: in_stock or reserved → sold; sold → in_stock on a return or cancel.
  - Approval memos: ↔ on_approval.
  - Purchases: → returned_to_vendor.
  - Refinery: melting → melted.
- **Transfers:** dispatch moves a piece to in_transit; receive moves it to in_stock at the receiving branch; return moves it to in_stock at the source.
- **Adjustments:** approving a `full_write_off` (tag_id required, deltas = minus the piece's full pieces/weights) → `written_off`, set as inventory_writer.
  No other route reaches it, and a written_off piece can never move, be transferred or change status again (409 `tag_written_off`).
  Kind `write_off` stays partial and may not take a piece to zero pieces (422 `use_full_write_off`).
- Anything else gives 409 `invalid_status_transition`.

## 5. Settings: `/v1/inventory/settings` (decision: a dedicated resource, not keys in `/v1/settings`)

The fields mirror `inventory.shop_setting`. When a shop has no row, GET returns the defaults with `source: default`, `version: 0`.

- **`tag_format`** is a structured object:

  | Field | Default |
  |---|---|
  | `prefix` | `T` (A-Z0-9, up to 8 characters) |
  | `separator` | `''` (also `-` or `/`) |
  | `branch_segment` | false |
  | `item_segment` | false |
  | `segment_order` | `branch_item` (or `item_branch`) |
  | `start_no` | 1 |
  | `digits` | 6 (1-12) |

  The rendered form is: prefix, then [separator + segment] for each enabled segment, then separator, then the zero-padded number.
  For example, the defaults give `T000123`, and `{prefix:"", separator:"-", branch_segment:true, item_segment:true}` gives `CBE-RNG-000123`.
  The rendered value is at most 30 characters (tag_no is varchar(30)); otherwise the server returns 422 `invalid_tag_format`.
- **`adjustment_approver`:** `owner_or_manager` (default) or `owner_only`.
- **`photos_enabled`**, **`ageing_enabled`:** both default to false.
- **`ageing_bucket_days`:** lower bounds, 1-8 values, default `[30,90,180,365]`.
- **Edits:** PATCH needs `inventory.settings.edit` (owner) and is audited.
- **Tag-format preview:** POST `/settings/tag-format/preview` renders samples, the scope_key and the next number without allocating anything.
- **Not supported:** date tokens or a yearly/monthly reset (the DB has none), and per-branch settings.

### Tag numbering (lead decision 2)

- The server assigns `tag_no`. Clients never send it; only the opening import may keep a tag_no from the file.
- The counter is `inventory.tag_counter`, keyed by `scope_key` = the rendered non-number part (e.g. `CBE-RNG-`).
  So the sequence runs per branch and/or per item when those segments are on, and per shop otherwise.
  Allocation is `INSERT … ON CONFLICT DO NOTHING`, then `UPDATE … SET next_no = greatest(next_no, start_no) + n RETURNING` under a row lock.
  A bulk request allocates n consecutive numbers.
- **Format change:** existing tags are never renumbered. tag_no is stored and never recomputed. A new rendering means a new scope_key,
  which starts at `start_no`. Going back to an old format resumes that scope's counter.
- **Collision:** if a manually imported tag already holds a number (23505 on tag_no), the counter skips it and takes the next one.
  Gaps are acceptable.

## 6. Behaviour decisions

- **Bulk tagging:** 1-200 `rows` plus `common` fields. It is all-or-nothing: 422 with one `errors[]` entry per bad field (`rows.N.field`).
  Numbers are allocated in row order, and `print_labels: true` returns the label batch.
- **Tag edits:** only the columns app_rw may update (960 + 987).
  - Weights and pieces change only through an approved adjustment.
  - Location changes only through moves or transfers.
  - Item, purity, tag_no and rfid_epc never change.
- **Photos (decision):** at most 10 per piece; JPEG, PNG or WebP up to 5 MB (the same as the existing `/v1/files` image rule).
  The file purpose is `tag_photo` (stored in the attachments area). One primary photo per piece.
  When the feature is off, adding a photo gives 409 `feature_disabled`, but reading and deleting still work.
- **Labels (decision):** POST `/v1/inventory/labels` with `{tag_ids ≤200, copies 1-5, reprint}`.
  - It is a POST because it records the print. The data comes from `v_tag_label`.
  - A tag printed before needs `reprint: true`, otherwise 422 `reprint_required`. Reprints are audited.
  - The print template doc_type is `tag_label` (already exists).
  - The client renders the barcode from `barcode_payload` (= label_payload or tag_no): Code128 by default, QR when the template says so.
- **Loose stock:** balances come from `v_loose_stock`, keyed by (branch, counter, tray, item, purity). There is no id and no version.
  Pieces are optional and default to 0. Stock comes in through `/loose-stock/receipts` (`non_tag_in`), a lot close, or the import.
- **Moves:** POST `/moves` handles one destination in the same branch, with tags and/or loose lines.
  - Every entry writes one `location_move` row plus a `move_out` / `move_in` ledger pair carrying the counter and tray.
  - Branch totals never change.
  - Pieces that are in_transit, or at another branch, give 409.
- **Transfers (lead decision 4):**
  - Flow: draft → approved → in_transit → received.
  - Approval is mandatory (the DB check `approved_chk`). A dispatcher who also holds `transfer.approve` is recorded as the approver on dispatch.
  - Receipt can be partial: lines not listed stay in_transit, and the transfer stays `in_transit` until every line is received.
    A partial receipt needs a note of at least 3 characters (0.8.2; was 5).
  - The sender can call `/return` to cancel back to the source. Unreceived lines go back to in_stock at the sender (ledger `transfer_in`),
    and the status becomes `returned`.
  - `/cancel` works only before dispatch.
  - There is no partial weight per line (`stock_transfer_line` has no received weight). A shortage is handled as a received line plus an adjustment.
- **Stock check (lead decision 6):**
  - Scope is a branch, one counter or one tray (`stock_take.counter_id/box_id`).
  - Checks run against live stock, not a snapshot. Expected pieces are those in_stock or reserved in scope when the report is read.
  - Scans are posted one at a time. Repeating a code returns `duplicate: true`. A wrong scan can be undone with DELETE.
  - Only one open check is allowed per exact scope (409 `check_already_open`). Overlapping scopes (a branch check plus a tray check) are allowed.
  - The report comes from `v_stock_take_report`: matched, missing, or extra with `extra_reason`.
  - Close can create one pending `write_off` / `loss` adjustment per missing piece.
- **Adjustments (lead decision 7):**
  - Each adjustment is one row covering one piece or one loose balance. `kind`, `reason_code` and the sign rules follow 988.
  - The approver rule comes from settings. A manager under `owner_only` gets 403 `approver_rule`.
  - Self-approval gives 403 `self_approval`, except for an owner. An owner's self-approval is allowed and audited as `inventory.adjustment.self_approved`.
  - `decided_as_role` is recorded.
  - Approval applies immediately, in the same transaction: an `adjustment` ledger row, tag gross/net/pieces (as inventory_writer), or the loose balance.
  - `approval_request_id` stays null; the generic Approvals inbox is not used yet.
  - Approvers are notified through the outbox topic `inventory.adjustment_pending`, with recipients resolved by the API.
  - Mirage's kinds map as follows:

    | Mirage kind | kind / reason_code |
    |---|---|
    | lost | `write_off` / `loss` |
    | damaged | `weight_loss` / `breakage` |
    | weight_correction | `correction` / `weighing_error` |
    | found_extra | `piece_gain` or `weight_gain` / `count_error` |

- **Valuation (lead decision 5):**
  - Computed on the server from `v_stock_valuation`: `metal_value = round(net_wt × rate, 2)`.
  - The rate is today's IST rate for the purity, taking the branch's own rate first, then the shop rate.
    Loose stock with no item (old metal) uses the `old_metal` rate.
  - GST is excluded and loose stock is included.
  - There is no stone or making value yet, so `total_value = metal_value`.
  - A missing rate gives a null value, and the purity is listed in `missing_rate_purity_ids`.
  - Cost is not exposed.
- **Numbers (lead decision 4 of 09:39):** transfer_no `TRF-{BRANCH}-{FY}-{SEQ:5}` and adjustment_no `ADJ-{BRANCH}-{FY}-{SEQ:5}`, server-assigned,
  per shop + branch + Indian FY (FY 2627 = Apr 2026–Mar 2027), counters in `platform.doc_counter` (doc_type `stock_transfer` / `stock_adjustment`).
  The formats are shown read-only in settings (`transfer_no_format`, `adjustment_no_format`) until shop_setting gains the columns (§8).
- **Ageing (lead decision a of 09:39, replaces decision 9):**
  - The age is today (IST) minus `since` = COALESCE(tag.received_on, IST date of tagged_at) from `v_tag_ageing`; `age_basis` is `received` or `tagged`.
  - Buckets are computed on the server from `ageing_bucket_days`.
  - When `ageing_enabled` is false the report gives 409 `feature_disabled`.
  - Only tagged pieces are included.
- **Opening stock:** uses the existing import kind `stock`, which covers both tagged and loose rows.
  The commit goes through the Inventory service (lot entry_type `opening`, ledger `opening`).

## 7. Mirage's questions (frontend/INVENTORY_API_ASSUMPTIONS.md), answered

| Q | Answer |
|---|---|
| Q1 Permission codes | No. Use the 16 codes in §3, not `inventory.<area>.view/.manage`. The approval code is **`inventory.adjustment.approve`** (singular). Valuation and ageing are separate (`valuation.view`, `ageing.view`). Transfers are split into dispatch, receive and the existing `transfer.approve`. Also new: `tag.print_label`, `tag.photos`, `tag.status_change`, `move`, `stock_check.run` / `.close`, `settings.edit`. |
| Q2 Tag numbering | Yes, the server assigns it. It is a **structured object**, not a token string: `{prefix, separator, branch_segment, item_segment, segment_order, start_no, digits}`. The sequence runs per rendered non-number part: per branch and/or item when those segments are on, otherwise per tenant. There are no year/month tokens and no reset. A format change never renumbers old tags, and the new rendering starts its own counter at `start_no`. A collision skips the number. Use POST `/settings/tag-format/preview` to render samples. Your `{BRANCH}-{ITEM}{SEQ:5}` default maps to `{prefix:"", separator:"-", branch_segment:true, item_segment:true, digits:5}` → `MAIN-RNG-00042` (the separator also comes before the number). |
| Q3 Bulk tag | All-or-nothing, 422 `errors[].path = rows.N.field` (N zero-based). At most **200** rows. POST `/v1/inventory/tags/bulk {source, lot_line_id?, common{…}, rows[]}`, returning `{items, first_tag_no, last_tag_no, labels?}`. |
| Q4 Transfers | Partial receipt is allowed, with a note of at least 3 characters (0.8.2). Unreceived pieces **stay in_transit** (the transfer stays `in_transit`) until a later receipt, or until the sender calls `/return`, which sends them back to the source (in_stock there) and sets the status to `returned`. Nothing becomes `missing` automatically; a write-off is a separate adjustment. |
| Q5 Valuation | **The server values it.** Do not multiply on the client. Today's IST **sale** rate (branch first, then shop); old metal uses the old_metal rate. GST excluded, loose stock included. In this build `metal_value` only (`total_value = metal_value`, no making, wastage or stone value), so drop the client maths in `valuation.ts`. A missing rate gives a null value plus `missing_rate_purity_ids`. |
| Q6 Stock check | **No snapshot.** The check runs against live stock. Use **one POST per scan** (`/stock-checks/{id}/scans {code}`), which is idempotent per code and can be undone with DELETE. The report is GET `/report` (matched / missing / extra + extra_reason). Two open checks on the **same** scope give 409. Different or nested scopes (branch + tray) can overlap. |
| Q7 Adjustments | Self-approval is **blocked on the server** (403 `self_approval`) unless the approver is an owner (then allowed and audited as self-approved). Under `owner_only` a manager gets 403 `approver_rule`. Yes, approval applies **immediately** (net/gross/pieces and the ledger, in the same transaction). There is no "approval off" mode: every adjustment starts `pending`. |
| Q8 Photos | The purpose is **`tag_photo`**, not `piece_photo`. JPEG, PNG or WebP, max **5 MB**, max **10** per piece. The feature toggle is `photos_enabled`. |
| Q9 Ageing | **Corrected in 0.8.1:** based on COALESCE(received_on, tagged date) (IST calendar days); each row has `age_basis` (`received` / `tagged`). The edges are stored in settings as `ageing_bucket_days` (lower bounds, default [30,90,180,365]), and **the server computes the buckets**: GET `/v1/inventory/reports/ageing`. |
| Q10 Settings | A separate `GET/PATCH /v1/inventory/settings`, with If-Match once saved. The fields are listed in §5 (`adjustment_approver` is `owner_or_manager`/`owner_only`, and there is no `adjustment_approval_required`). |
| Q11 Labels | **POST** `/v1/inventory/labels {tag_ids ≤200, copies, reprint}` (POST because it records the print) returns label data from `v_tag_label`. The print-template doc_type is `tag_label`. **The client renders the barcode** from `barcode_payload`: Code128 by default, QR when the template says so. |
| Q12 Tag lookup | Yes. The route is now GET `/v1/inventory/tag-lookup/{tagNo}`, with `branch_id` optional and falling back to `X-Branch-Id`. With no branch at all, `sellable` is null. Pieces at another branch are returned with `sellable: false`. |
| Q13 Loose stock | The balance is per **branch + counter + tray + item + purity** (counter/tray null means branch level). It has no id, and **pieces are optional** (0 when not tracked). GET `/loose-stock`, POST `/loose-stock/receipts`. There is no free "out" movement: stock leaves through sales, tagging, moves, transfers and adjustments. |
| Q14 Piece read | Confirmed: GET `/v1/inventory/tags/{id}` (and the list, history, lookup and photos) needs **`inventory.stock.view`**. |

Route renames versus your placeholders:

| Your placeholder | Contract route |
|---|---|
| `/pieces` | `/tags` |
| `/loose` | `/loose-stock` |
| `/ageing` | `/reports/ageing` |
| `piece_ids` | `tag_ids` |
| `received_piece_ids` | `line_ids` (transfer line ids) |
| `/moves {counter_id, tray_id}` | `{branch_id, to_counter_id, to_tray_id}` |

## 8. Asks for Perceptor (data model)

Resolved in the final 988/989: `stock_adjustment.approval_request_id` (nullable FK to approvals.request) and
`v_stock_valuation.total_value` + `value_basis` ('metal'). Still open:

Also resolved in the updated 987-989: the `written_off` status, the `full_write_off` kind, `v_tag_ageing.age_basis`, and the README status list.

1. ~~shop_setting number formats~~ **resolved (Perceptor, 10:13):** `transfer_no_format` / `adjustment_no_format` exist (default
   TRF-/ADJ-{BRANCH}-{FY}-{SEQ:5}); editable through PATCH /v1/inventory/settings with 422 validation (exactly one {SEQ}/{SEQ:n}, last;
   only {BRANCH} {FY} {SEQ}; ≤ 64 chars). Counters: `platform.doc_counter` doc_type stock_transfer / stock_adjustment.
2. ~~Salesperson `inventory.move` seed~~ **resolved:** seeded in 987; own branch only (tested). Branch transfers stay excluded.
3. Per-line received weights on transfers don't exist (fine for now; shortages are handled with adjustments).
4. ~~`stock_transfer_line.from_counter_id` / `from_box_id`~~ **resolved:** loose lines leave from (and return to) a counter / tray;
   `loose_location_unsupported` is gone.
5. **Per-shop permission override: deferred to P6** (docs/OPEN-ITEMS.md #8). Roles are global (`system_role_permission`); an
   owner cannot change them per shop in this build.
6. ~~vendor lot reference~~ **resolved (987 re-landed, 0.8.3):** `tag.vendor_lot_ref` (1-60 chars) is accepted on TagInput, BulkTagInput
   and TagPatch, written by app_rw (inventory_writer has no UPDATE on it) and returned on Tag. Original request:
   `ALTER TABLE inventory.tag ADD COLUMN vendor_lot_ref text CONSTRAINT tag_vendor_lot_ref_check CHECK (char_length(vendor_lot_ref) BETWEEN 1 AND 60);`
   (INSERT is table-level for app_rw already; add `GRANT UPDATE (vendor_lot_ref) ON inventory.tag TO app_rw` if it should be
   editable later). Until then `vendor_lot_ref` in BulkTagInput → 422 field_not_supported.
7. ~~`{FY}` token style~~ **resolved:** lead decision (a) 10:46 IST: '2627'; 987's comment was updated. 987's comment says `{FY}` renders like platform.fy_of ('2026-27'); the service renders the lead's
   example style '2627' (TRF-CBE-2627-00001). Needs one answer; the code is a one-line switch.

## 9. Open questions

- Inter-state branch transfers need a delivery challan / e-way bill: logged as item 7 in `docs/OPEN-ITEMS.md` for Sales/GST.
- The Platform `stock` import goes through the Inventory service (lead decision 6) via a registry hook: Platform calls `stockImporterOf()` and the InventoryModule registers `importOpeningStock` on init (all-or-nothing; any row error → 409 import_rows_rejected). Platform does NOT depend on `@jw/mod-inventory` (that would be a package cycle, since Inventory depends on Platform); with no Inventory module loaded the commit answers 503 inventory_unavailable.
- `stock_adjustment.approval_request_id` is always null for now: approvals go through the Inventory approver rule (`shop_setting.adjustment_approver`), not the Approvals module.

## 10. 0.8.2 changes (lead decisions on Mirage's gaps, 5 Nov 2026 10:17 IST)

1. Every tag / transfer / adjustment number contains the sequence. Tags: the number is structural, so prefix "" with no segments gives the
   zero-padded number only. Transfer / adjustment formats must contain exactly one `{SEQ}` / `{SEQ:n}` (validated on settings save, 422).
2. If-Match (428 missing, 412 stale) on transfer approve / dispatch / receive / return / cancel, stock-check close / cancel, tag status,
   tag PATCH and tag bulk-update (list form `"3", "7"` in items[] order, header `IfMatchList`). Dispatch and receive also take Idempotency-Key.
3. Every reason / note minimum is 3 characters (trimmed), including the partial-receipt note (was 5) and the adjustment reject note.
   Tag status `reason` is now required in the spec (the service always required it).
4. POST /v1/inventory/labels takes Idempotency-Key (required), so a retry does not double label_print_count.
5. `StockValuation.includes` is the named schema `StockValuationIncludes` {metal, loose, stone_value, making, gst} (booleans);
   ledger `direction` is `in` | `out`.
6. Ageing buckets carry `code` (`0_29`, `365_plus`) and `label` ("0–29 days", "365+ days"); the first bucket is 0–(N−1) days.
7. `sellable` on tag lookup is null when no branch is given (query or X-Branch-Id).
8. Enums carry stable codes; English labels are fine. Stock-check extras: `extra_reason` enum `StockCheckExtraReason`
   (unknown_code | other_branch | other_location | wrong_status) + `extra_note` (the status code for wrong_status). Replaces `status_<status>`.
9. `stone_value` comes later. `vendor_lot_ref` (optional, ≤ 60) on bulk tagging is in the spec but refused (422) until the column in §8.6 exists.
10. Starting a stock check needs only `inventory.stock_check.run`; close / cancel need `inventory.stock_check.close`.
11. See 8: `extra_reason` enum + optional note.
12. The YAML parses (redocly lint clean on the VPS).
13. Approvals stay mandatory; no setting turns them off.

Also in 0.8.2: TagPatch / bulk-update edit every app_rw-granted descriptive column (960 + 987); `stones` → 422 field_not_editable.
Transfer lines carry `from_counter_id` / `from_tray_id`. Tag create / bulk accept the full TagInput descriptive fields; `source: loose`
is not built yet (422 source_not_supported).

## 11. 0.8.3 changes (lead decisions, 5 Nov 2026 10:46-10:58 IST)

1. The twelve 501 operations are built: listLots, createLot (LOT-{BRANCH}-{FY}-{SEQ:5}), getLot, updateLot, closeLot, getTagHistory,
   listTagPhotos, updateTagPhoto, getStockSummary, listLocationMoves, updateStockTransfer, listStockCheckScans.
2. Unknown request-body fields → 422 `validation_failed` with one `errors[]` entry per field, `code: field_not_supported` (Problem.errors
   items now carry an optional `code`). `vendor_lot_ref` is supported (column landed).
3. Stock-check scans and undo do not change the check's `version`; only session-level changes (close, cancel, edit) do.
4. Close with `create_adjustments: true` creates one pending `full_write_off` adjustment (reason_code loss) per missing tagged piece.
5. `Tag.pieces` is required in responses (default 1).
6. Intro: Inventory transitions (approve, dispatch, receive, return, cancel, close) take If-Match; inventory is built (no "awaiting 987-989").
7. Ageing `groups[].buckets` have the same codes, labels and order as `totals`.
8. Recording a scan: `extra_reason` wrong_status + `extra_note` (status code); 409 check_closed.
9. ~~Not possible with today's grants (409 `line_removal_unsupported`)~~ Resolved in 0.8.4 (§12): Perceptor's 987/988 give app_rw a
   policy-guarded DELETE on lot_line and stock_transfer_line; `line_removal_unsupported` is gone.
10. Photo `url` / `thumb_url` are not returned; clients call GET /v1/files/{file_id}/url (Inventory registers a file-access resolver: anyone
    who can see the piece). getStockSummary also excludes `written_off`.
11. New codes: lot_not_open, lot_line_exhausted, below_tagged, ~~line_removal_unsupported~~ (dropped in 0.8.4), lot_has_remainder, duplicate_lot_no,
    invalid_lot_no, transfer_not_draft; field-level (errors[].code): line_tagged, purity_required, primary_required, field_not_supported.

## 12. 0.8.4 changes (lead decision, 5 Nov 2026 11:25 IST): line removal

Perceptor's 987/988 (test DB only; schema_migrations 987 fb0faeaa…, 988 1b0c2e2f…, 989 b16a639b… unchanged) let app_rw DELETE:
- `inventory.lot_line` under RESTRICTIVE policy `rw_delete_open_lot_only`: the lot is open or tagged, `tagged_pieces = 0`, and no tag
  references the line (new index `tag_lot_line_idx` on tag(tenant_id, lot_line_id));
- `inventory.stock_transfer_line` under `rw_delete_draft_only`: the transfer is draft.

A delete the policy refuses affects 0 rows and raises no error. The service checks first (specific codes), deletes, and maps rowCount 0
by re-reading: lot line → 409 `line_tagged` / 409 `lot_not_open` / 404; transfer line → 409 `transfer_not_draft` / 404. Tenant and
branch scope are unchanged; audit rows come from the table triggers.

1. PATCH /lots/{id} (updateLot): `lines` is still the whole list; a line left out is deleted in the same transaction. A left-out line with
   tagged pieces (or a piece pointing at it) → **409 `line_tagged`** for the whole request (was 422 below_tagged in 0.8.3). Lowering a
   kept line below its tagged pieces stays 422 below_tagged; changing its item stays 422 with errors[].code line_tagged. Only open lots
   are edited (409 lot_not_open). If the remaining lines are all fully tagged, the lot moves open → tagged (same rule as tagging).
2. PATCH /transfers/{id} (updateStockTransfer): rows for pieces still listed are kept, others are reused, rows left over are deleted
   (before the writes, so a dropped piece is free for another transfer at once). Draft only (409 `transfer_not_draft`); 1-500 lines.
3. Codes: `line_removal_unsupported` removed; `line_tagged` is now also a 409 top-level code (lot line removal).
4. (lead, 11:39 IST) Scan outcomes: the POST scan response, the scan list (StockCheckScan) and the report rows all carry `result`,
   `extra_reason`, `extra_note`, `duplicate`. **Not stored yet**: inventory.stock_take_scan has only tenant_id, id, stock_take_id,
   scanned_code, tag_id, scanned_by, scanned_at, so the outcome is computed from v_stock_take_report when read (it follows the
   piece's current state, e.g. a piece sold after the scan reads wrong_status / sold). Repeat scans are not stored (unique code / tag),
   so stored scans are `duplicate: false`. Ask for Perceptor (no SQL edited here), see §13.
5. GET /v1/files/{id}/url: piece photos (tag_photo, attached to a piece) are readable by anyone with inventory.stock.view who can see the
   piece's branch (the resolver was already there; the operation summary still said platform.import.run only, now per file kind).
6. closeLot takes If-Match (428 missing, 412 stale; ETag on 200). Closing a closed lot at its current version returns it unchanged.
7. Fixes found on the way: addTagPhoto answered 409 `duplicate_photo`; now `already_attached` as the contract says. The stock-check
   report now answers the documented StockCheckReportPage (`next_cursor: null`, `counts`) and rows carry `status`, `branch_id`, `labels`.
8. POST /v1/files now accepts purpose `tag_photo` (needs inventory.tag.photos). It was in the contract enum, but the uploader answered 422 until now.

## 13. Ask for Perceptor: store the scan outcome (inventory.stock_take_scan)

Columns (all on inventory.stock_take_scan):
- `result text NOT NULL CHECK (result IN ('matched','extra'))` (existing rows: backfill from v_stock_take_report, else 'extra')
- `extra_reason text NULL CHECK (extra_reason IN ('unknown_code','other_branch','other_location','wrong_status'))`,
  `CHECK ((result = 'extra') = (extra_reason IS NOT NULL))`
- `extra_note text NULL CHECK (char_length(extra_note) <= 40)`, `CHECK (extra_note IS NULL OR extra_reason = 'wrong_status')` (tag status
  at scan time)
- `duplicate_count integer NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0)` and `last_duplicate_at timestamptz NULL` (a repeat scan
  bumps them; the API's `duplicate` on the list = duplicate_count > 0)

Grants for app_rw: INSERT (result, extra_reason, extra_note); UPDATE (duplicate_count, last_duplicate_at) only. v_stock_take_report:
prefer the stored values for scanned rows (coalesce(sc.result, …), coalesce(sc.extra_reason, …)) so the report and the list agree.
