# Masters contract notes (contract 0.6.1, frozen 28 Oct 2026)

Source of the freeze list: the "Jewellery SaaS feature freeze" Page (Masters section). Must-have: M1-M8, M10-M15, M17. Deferred (not in the contract): M9 customer groups, M16 discount schemes.

## Conventions (all masters)
- `GET /v1/masters/<x>`: `q` (≤100 chars, code/name, case-insensitive), `include_inactive` (default false), `limit` (1-100, default 25), `cursor`. Returns `{items, next_cursor}`. Exception: metals and purities stay unpaged arrays (small lists, unchanged shape), with `q` added.
- `POST` creates and returns 201, `version: 1` and `ETag: "1"`. Duplicate code returns 409.
- `GET /{id}` returns the row with `ETag: "<version>"`. Inactive rows can still be read by id.
- `PATCH /{id}` needs `If-Match: "<version>"`. A missing header returns 428 `precondition_required`; a stale one returns 412 `version_mismatch`. Immutable fields (code, kind, parent id) are not in the Patch schemas.
- There is no DELETE. Send `PATCH {is_active:false}` to deactivate and `{is_active:true}` to reactivate. Using an inactive master on a new document returns 422 `inactive_master`.
- Money is a 2 dp decimal string, weight a 3 dp decimal string, and percent/fineness are decimal strings. JSON numbers are never used.
- Tenant RLS applies to everything. All writes, customers included, need `platform.settings.edit`. Lead decision (b): no stopgap; they move to `masters.*` permissions once Perceptor adds them.
- Ownership: masters never mutate stock (that's Inventory) and never write invoices (that's Sales). Documents snapshot master values.
- Each awaiting operation carries `x-backing` in openapi.yaml. Until it lands, it isn't routed (404).

## Endpoints per master
| # | Master | Paths | Table | Status |
|---|---|---|---|---|
| M1 | Metals | /v1/masters/metals, /{id} (GET new in 0.6.0) | masters.metal | **implemented** |
| M2 | Purities | /v1/masters/purities, /{id} (GET new in 0.6.0) | masters.purity | **implemented** |
| M3 | Item categories | /v1/masters/items, /{id} | masters.item | awaiting 976: version (is_active exists) |
| M4 | Designs + photos | /v1/masters/designs, /{id}, /{id}/photos (multipart, If-Match), /{id}/photos/{fileId} (DELETE = detach) | masters.sub_item + platform.file (area attachments) | awaiting 976: version, is_active, photo_file_ids |
| M5 | Stones/diamonds | /v1/masters/stone-standards, /v1/masters/stone-rates (+/{id}) | masters.stone_standard, masters.diamond_rate | awaiting 976: version, is_active (both) |
| M6+M7 | Making charge + wastage (VA) rules | /v1/masters/value-addition-rules, /{id} (one rule row carries MC and wastage; fields are tagged `x-field-group: making_charge | wastage` with `[Making charge (M6)]` / `[Wastage / VA (M7)]` descriptions so the UI can show two sections; API `design_id` = sub_item_id) | masters.value_addition_rule (+ item/design defaults on M3/M4) | awaiting 976: version, is_active, mc_percent |
| M8 | Customers | /v1/masters/customers, /{id} | masters.customer | awaiting 976: version, is_active |
| M10 | Suppliers/karigars | /v1/masters/vendors, /{id} (kind smith = karigar) | masters.vendor | awaiting 976: version (is_active exists). Balances come from Accounts later and aren't in the master |
| M11 | Staff | /v1/masters/staff, /{id} | hr.staff | awaiting 976: version, is_active |
| M12 | Counters/trays | /v1/masters/floors, /counters, /trays (+/{id}) | masters.floor, masters.counter, masters.box | awaiting 976: version, is_active (all three), floor.code |
| M13 | HSN codes | /v1/masters/hsn-codes, /{id} | none | awaiting 976: new table masters.hsn_code |
| M14 | Payment modes | /v1/masters/payment-modes, /{id} | none | awaiting 976: new table masters.payment_mode |
| M15 | Banks + card machines | bank accounts: /v1/companies/{companyId}/bank-accounts (unchanged); /v1/masters/card-machines, /{id} | masters.bank_account; none | bank accounts **implemented** (0.4.x); card machines awaiting 976: new table masters.card_machine |
| M17 | Import/export | POST /v1/imports with the new ImportKind values; GET /v1/import-templates/{kind}; /v1/exports, /v1/exports/{id}; download via GET /v1/files/{file_id}/url | platform.import_job, import_row_error, file (area exports) | awaiting 976: kind checks widened, platform.export_job. Excel (xlsx) export is new |

## Schema needs for Perceptor (976+)
1. Add `version int NOT NULL DEFAULT 1` with the aa_version trigger to masters.item, sub_item, stone_standard, diamond_rate, value_addition_rule, customer, vendor, floor, counter, box, and hr.staff.
2. Add `is_active boolean NOT NULL DEFAULT true` to the same tables except item and vendor, which already have it.
3. masters.sub_item: add `photo_file_ids uuid[] NOT NULL DEFAULT '{}'`, or a join table (sub_item_id, file_id, sort) with an FK to platform.file. A join table is preferred. Including design photos in the 975 `referenced_object_keys` check is **parked**.
4. masters.value_addition_rule: add `mc_percent numeric`. Freeze M6 asks for "per gram, percent, or fixed".
5. masters.floor: add `code varchar(10)`, unique per (tenant, branch).
6. New tables, all tenant-RLS with version and is_active:
   - masters.hsn_code(code, description, tax_rule_code), unique per tenant and code.
   - masters.payment_mode(code, name, kind, bank_account_id, requires_reference, sort_order).
   - masters.card_machine(branch_id, code, name, provider, terminal_id, bank_account_id, mdr_percent), with branch_scope.
7. platform.import_job / import_mapping_profile: widen `kind` to the 0.6.0 ImportKind list.
8. platform.export_job(id, kind, format csv|xlsx, status, row_count, file_id → platform.file, created_by, created_at), tenant RLS.
9. Payment-mode kind `old_gold`: Perceptor is widening the sales invoice payment-mode check to allow it (lead decision c).

## Breaking changes vs 0.5.1 (for Mirage)
- `Item` is now the full M3 category. ItemPage requires `next_cursor`. The `Customer` output no longer echoes `pan` (it returns `pan_last4`), and `preferred_locale` was dropped because the table has no such column.
- `GET /v1/files/{id}/url` currently needs `platform.import.run`. For design photos and exports, it should also allow viewers of masters. Lead decision (d): it will be widened later, with no change now.

## 0.7.1 (patch, on top of 0.7.0)

- **Permissions:** metals/purities reads use `masters.metals.view` and writes use `masters.metals.manage`. Cashiers can read but get 403 on writes.
- **Staff:** `department` and `designation` are free text (trimmed, 1–100 chars). Blank is stored as `null`. `department_id`/`designation_id` are gone from the API (984).
- **No Aadhaar anywhere:** `aadhaar_last4` on any party returns 422 `aadhaar_not_allowed`. KYC `doc_type` is a closed enum, so `aadhaar` returns 422 `aadhaar_not_allowed` and unknown types return 422.
- **KYC reveal:** `POST /v1/masters/{party}/{id}/kyc/reveal` with body `{reason: 10–500}`.
  - Requires `masters.kyc.reveal` (owner and manager).
  - Sends `Cache-Control: no-store` and is limited to 10 per user per hour; after that it returns 429 `rate_limited` with Retry-After.
  - Each revealed field writes one `platform.audit_append(... 'kyc.reveal' ..., {field, reason})` in the same transaction. The value is never written to the audit row.
- **Idempotency-Key** (optional, 16–128 chars `[A-Za-z0-9_-]`) is honoured on generic master creates, `POST /v1/files` and `POST /v1/masters/designs/{id}/photos`.
  - A replay returns the original status and body.
  - The same key with a different body returns 422 `idempotency_key_reused`.
  - A malformed key returns 422 `idempotency_key_required`.
- **Photos reorder:** `PATCH /v1/masters/designs/{id}/photos` with body `{order[], cover_file_id?}` and If-Match on the design version. It bumps the design version. If the order is not exactly the current photo set it returns 422 `photo_set_mismatch`.
- **Exports:** permission is `platform.export.run`. `GET /v1/exports` is paged as `{items, next_cursor}`. The maximum is 20000 rows; above that it returns 422 `too_many_rows`. The status enum matches the DB.
- **Vendor shapes (G7):** `addresses` holds up to 5 of `{line1, line2, city, district, pincode}`. `contacts` holds up to 10 of `{name, phone?, email?, role?}`.
- **Schema regenerations:** Design, StoneRate, Tray, HsnCode, PaymentMode, CardMachine, VA (added purity/sub_item/effective dates/priority), Customer (group_id, kyc_status, kyc_verified_*) and Staff (is_salesperson, photo_file_id) now match the code.
- **Known gaps:** the contract Phone pattern is wider than the app's Indian-mobile check, and floors and bank_accounts have no import kind.
- **Mirage round (0.7.1):**
  - Customer create and update summaries now say `masters.customers.manage`.
  - `GET /v1/masters/kyc-documents` takes `party_type` and `party_id` filters.
  - Every master list GET (including metals and purities) takes `?ids=` (1–100 comma-separated uuids). It still respects `include_inactive` and RLS.
  - Generic list rows carry `labels: {<ref field>: {code, name}}`, fetched with one batched query per ref. Single reads do not include labels.
  - Master list GETs document 403 and `masters.<area>.view`. The 982 seeds give every `.view` to owner, manager, salesperson and cashier.
  - Master lists use `MasterLimit` (1–200, default 50), which matches the code.
  - Per-master 422 codes are listed on each POST/PATCH 422 response.
  - Sub-item types are tightened. `SubItemInput` requires item_id, code and name, and rejects extra fields. `SubItemPatch` has no item_id and allows is_active.
- **Reveal rate limit (interim):** this is a per-process in-memory limit. The 910 CHECK on platform.rate_limit_bucket.bucket_key only admits login.* and otp.* keys, so the DB bucket can't be used until Perceptor widens it.

## 0.7.2 (patch)
- `POST /v1/masters/{party}/{id}/kyc/reveal` response gains required `pan_not_migrated` (boolean). For a vendor row that still has only the legacy `pan` (no `pan_enc`), `pan` is the masked legacy value (`XXXXXX` + last 4) and `pan_not_migrated: true`; no `kyc.reveal` audit is written for a masked value. Previously such rows returned `pan: null`.
- New `POST /v1/masters/vendors/pan-backfill` (masters.vendors.manage): seals legacy `vendor.pan` into `pan_enc` / `pan_key_id` / `pan_last4` for legacy-only rows of the caller's tenant. **Dry run by default** (`{}` or `{dry_run:true}`); `{dry_run:false}` writes. Never clears `pan` (the drop stays gated on `pan-backfill-status`). Returns `{dry_run, candidates, invalid, written}`; invalid legacy values are skipped. Not to be run against dev/prod data until Adithya approves; only the integration suite exercises it.
- hr.staff `department_id` / `designation_id`: backend does not write them (Perceptor guidance) — confirmed by grep, no code path references them.

## 0.7.3 (patch, 986)
- KYC reveal throttle is DB-backed: `platform.rate_limit_bucket` key `kyc.reveal:<tenant_id>:<user_id>`, 10 per fixed hour (the 10th reveal locks; the 11th → 429 `rate_limited` + Retry-After, Cache-Control: no-store). Survives restarts and is shared across API processes.
- `floors` is an import and export kind (`branch_code,code,name`; code optional).
- Card machines: `cash_counter_id` must reference an active cash counter (986 `accounts.cash_counter.is_active`) → 422 `inactive_master`. `hr.department` / `hr.designation` gained `is_active`, but the API exposes no department/designation resource (staff uses free text, 984), so there is nothing to filter yet.
- Deleting a design photo soft-deletes its `platform.file` (app_rw `UPDATE (deleted_at)` only) when no other master references the file.
- **Mirage round (0.7.3):**
  - G16: masters phones (customer, vendor contacts, staff) use `MastersPhone` = `^[6-9][0-9]{9}$`, exactly the code's rule. Input may carry spaces, dashes or a `+91`/`91` prefix, which the server strips; responses are always the bare 10 digits. Platform user / tenant-owner `Phone` stays `^[0-9]{10,15}$`, matching the platform code.
  - G17: `ids` is `style: form, explode: false` (`ids=a,b`); the server also accepts repeated `ids=a&ids=b`. This applies to every masters list, metals, purities and company bank accounts.
  - G18: `kyc_consent` (boolean) is back on CustomerInput / CustomerPatch. `true` sets `consent_at = now()` server-side, `false` clears it. `consent_at` itself is read-only.
  - G20 pickers: `settlement_bank_account_id` → `GET /v1/companies/{companyId}/bank-accounts`, now with `q` (bank / branch / holder / IFSC / last4) and `ids`. `account_head_id`: `accounts.account_head` exists in the schema but the API has no account-heads endpoint yet (needs an accounts module; tracked as a backend gap). `group_id` (M9) is marked `deprecated` in customer input; leave it unset.

## 0.7.4
- Rates: GET /v1/rates/todays-status, GET /v1/rates/rate-card, POST /v1/rates/batch (Idempotency-Key; derive = round(base × fineness / base_fineness, 2) half-up in numeric; overrides keep derived_rate_per_g), GET /v1/rates metal_id + effective_to (exclusive), MetalRate.derived_from_id/derived_rate_per_g, PrintDocType rate_card. Same-day re-publish = correction → rates.edit.
- C1: MastersPhoneInput (spaces, dashes, +91/91) for request bodies; MastersPhone (strict 10 digits) for responses.
- C2: card_machine.cash_counter_id → accounts.cash_counter (980 FK), not masters.counter. No cash-counter API yet (Accounts).
