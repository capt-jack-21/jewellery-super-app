# Masters — API gaps vs contract 0.6.1 (70300a7) (for Ironhide)

The Masters UI is built on the generated client (`src/lib/api/backend`, contract 0.6.0).
This file lists **only the gaps** where the UI works around something missing.

| # | Gap | What the UI does today | Ask |
|---|-----|------------------------|-----|
| G1 | Only metals, purities and bank accounts are live; the other masters (x-backing) return 404 until migration 976 | The screen shows a "not switched on yet" note and disables Add; MSW mocks cover dev and tests | Ship migration 976 and tell us as each kind goes live |
| G2 | No PAN / KYC reveal endpoint | PAN is write-only and only `pan_last4` is shown. A slot next to the masked value is reserved for an audited "Show" button with a mandatory reason (owner/manager) | Add the audited reveal endpoint (reason required) |
| G3 | No photo reorder | The first uploaded photo is the cover; to change the order you remove and re-add | Add `PATCH designs/{id}/photos` with an ordered `photo_file_ids` |
| G4 | `getFileDownloadUrl` needs `platform.import.run` | Photo thumbnails fail quietly (placeholder) for staff without import permission | Allow anyone who can read designs to read design-photo URLs |
| G5 | Idempotency-Key on master creates is not in 0.6.1 yet | The UI already sends `Idempotency-Key` on every create (one per attempt, kept across a retry, reset when the form changes) | Add it to the contract (422 `idempotency_key_reused` on a different body) |
| G6 | Staff `department_id` / `designation_id` are UUIDs, but the lead wants free text and there are no list endpoints | Left out of the form (a UUID can't be typed as text) | Change them to `department` / `designation` strings (nullable); the UI will add them as text inputs under More details |
| G7 | Vendor contacts / addresses are nested arrays | Not editable in the UI yet (only the name, kinds, phone, GSTIN and state) | Confirm the shape before we add a sub-form |
| G8 | No batch lookup by ids | Type-ahead pickers use `q` with `limit=20`; labels for the ids shown in a list are fetched one `GET` per distinct id | Add `?ids=` on lists, or embed `{id, code, name}` for refs in list rows |
| G9 | `bill_series_prefix` | Kept as it is today (unchanged) | — |
| G10 | Customer writes need `platform.settings.edit` | Gated through `CUSTOMERS_EDIT` in `lib/permissions.ts`, so it's a one-line switch | Tell us the new masters.* permission code when it lands |
| G11 | Aadhaar dropped (owner decision), but 0.6.1 still has `aadhaar_last4` on customers and staff | The UI never shows, sends or imports Aadhaar | Remove `aadhaar_last4` from the schemas, import templates and exports |
| G12 | No `kyc_type` field | `KYC_TYPES` (pan, passport, voter_id, driving_licence, gstin_certificate, other) and its labels are ready | Add `kyc_type` with that enum |

## Contract 0.7.0 (commit 9f0468e) — adapted 28 Oct 2026

- **Permissions:** writes are gated on `masters.<area>.manage` and reads (route guards) on `masters.<area>.view`. Areas: metals, items (+ sub-items), designs, stones (standards + rates), making_rules (VA), customers, vendors, staff, counters (floors/counters/trays), tax (HSN), payments (modes + card machines). KYC documents follow their party's area. `CUSTOMERS_EDIT` is now `masters.customers.manage`.
- **Idempotency-Key** (16–128 chars, a uuid) is sent on every master create, plus metal/purity, file upload and photo attach.
- **Photos:** upload with POST /v1/files (`design_photo`, max 5 MB), then attach `{file_id, caption, is_primary, sort_order}`. Move up/down and "Make cover" send one PATCH `{order, cover_file_id}` with If-Match on the design version. A 412 or 422 `photo_set_mismatch` reloads the photos. Remove uses If-Match on the photo version (204).
- **G2 resolved:** `POST …/{customers|vendors|staff}/{id}/kyc/reveal {reason}` sits behind `masters.kyc.reveal`. The result is kept in component state only, never in the TanStack Query cache, and is cleared on close or unmount. A 429 shows a Retry-After countdown.
- **Aadhaar:** `aadhaar_last4` has been removed. Staff `department` and `designation` are free text (max 100 characters).
- **New:** sub-items and KYC documents (number write-only, `number_last4` masked; file via `kyc_document` upload), and a vendor PAN backfill notice.
- **422 codes:** not documented per master yet. Field errors are mapped generically from `errors[].path`.
- **G13 (closed in 0.7.1):** server filter `party_type`+`party_id` now used; client filter removed. Was: GET /v1/masters/kyc-documents has no `party_type` / `party_id` filter. We send both and also filter on the client, but a party with more than one page of other parties' documents could miss rows.
- **G14 (closed in 0.7.1):** summaries now say masters.customers.manage. Was: customer create/update summaries still say `platform.settings.edit`, while the header says `masters.customers.manage`. We follow the header.
- **G15 (closed in 0.7.1):** `/masters/customers` guarded by masters.customers.view (seeded to all four roles). Was: is there a customers view perm for counter staff? Today `/masters/customers` is not route-guarded and the server enforces access.

## Contract 0.7.1 (commit b750c91, backend 84485a8) — adapted 28 Oct 2026

- Perms/roles mirror seeds 982/984: every `masters.*.view` → owner, manager, salesperson, cashier; `.manage` and `masters.kyc.reveal` → owner, manager. Metals no longer owner-only (cashier: read yes, write 403, as 397dd2e).
- Ref labels: list rows' `labels {<field>: {code, name}}` first; missing ids resolved with `?ids=a,b` (one comma-joined value, ≤100 per call, chunked, include_inactive). List limit clamped to 1–200 (default 50).
- 422 codes mapped to friendly en/ta messages (`error.<code>`), at field level via `errors[].path`, falling back to the field the code implies.
- Sub-items: create = strict SubItemInput; edit = SubItemPatch (item_id create-only, never sent; only changed fields).
- Phone: client validates an Indian mobile exactly as the backend (strip spaces/dashes and +91/91, then `^[6-9]\d{9}$`).
- Schema realignment from the regen: designs (sub_item_id, purity_id, designer_id, approx weights, size, description, tags, primary_photo_file_id; no hsn/MC/measurement), stone rates (stone_id or cent_group_id, rate_unit, sale_rate/purchase_rate, effective_to), VA rules (purity_id, sub_item_id, effective dates, priority), trays (name, sub_item_id, tare optional), HSN (code_type, uqc), payment modes (account_head_id, requires_card_machine), card machines (provider, supports, cash_counter_id, merchant_id, mdr_pct, settlement_bank_account_id), staff is_salesperson, export `filters.include_inactive`, import/export kinds renamed to 981 names.

Open:
- **G16:** `Phone` schema (`^[0-9]{10,15}$`) and Customer `phone` (`^[0-9]{10}$`) don't state the backend rule (6–9 start, +91 stripped). We follow the backend.
- **G17:** `ids` is style=form, explode=false, but Orval generates repeated `ids=`; we pass one comma-joined string. Mock rejects repeated `ids`.
- **G18:** `kyc_consent` was removed from CustomerInput with no replacement — how is `consent_at` recorded now? Field removed from the form.
- **G19:** KYC reveal rate limit is per-process until the bucket_key CHECK admits `kyc.reveal` (7ff6780). UI already handles 429 + Retry-After.
- **G20:** no picker endpoints for `account_head_id` / `settlement_bank_account_id` / `group_id` in the masters surface; not on the forms yet.

## Rates (built on contract 0.7.1 + MSW; for Ironhide / 0.7.3) — 28 Oct 2026

Screens: `/rates` (entry + in-effect + banner), `/rates/history`, `/rates/card`; banner also on home and wizard step `todays_rates`.
All calls go through `src/features/rates/api.ts` only; mock in `src/mocks/handlers.ts` (`todaysRateStatus`).

Reused as-is: `GET /v1/rates/current?branch_id` (branch row beats shop-wide), `GET /v1/rates` (history, `{items,next_cursor}`, 422 `invalid_cursor`),
`POST /v1/rates` (`{purity_id, branch_id?, kind, rate_per_g "^[0-9]{1,10}\.[0-9]{2}$"}`, insert-only, IST `rate_date`).

| # | Assumed | Shape | Status |
|---|---|---|---|
| R1 | `GET /v1/rates/todays-status?branch_id=` (from `rates.v_todays_rate_status`) | `{ branch_id: uuid\|null, rate_date: date, missing_metal_codes: string[], missing_old_metal_codes: string[], todays_rate_set: bool }` — a metal counts as set if a sale (resp. old_metal) row for today exists for the branch or shop-wide. No branch_id = shop-wide rows only. | open |
| R2 | `PrintDocType` gains `rate_card` | client renders the card today (`data-doc-type="rate_card"`); same locale/numeral rules as other docs; codes Latin | open |
| R3 | `metal_id` filter on `GET /v1/rates` | currently filtered client-side (may under-fill a page) | open |
| R4 | Base-rate derivation | client derives `base × fineness / base_fineness`, ROUND_HALF_UP 2dp, base = finest active purity of the metal, and POSTs one row per purity (N calls, not atomic). Prefer `POST /v1/rates/batch {branch_id?, kind, base_purity_id, rate_per_g}` with server derivation, or confirm the rule. | open |
| R5 | `v_billing_unlocked.todays_rate_set` | mock: onboarding `todays_rates` completed only when every active branch has a sale rate for every active metal today; `missing_billing_steps` then omits it. Please expose per-branch value (or confirm "any branch"). | open |

## Contract 0.7.3 (backend e566c2a) — adapted 28 Oct 2026

Closed: **G16** (MastersPhone `^[6-9][0-9]{9}$` for customers/vendors/staff/contacts; client keeps its check and strips spaces, dashes and +91; platform user/owner Phone stays 10–15), **G17** (ids: server accepts joined or repeated; the joined-string workaround is gone — the generated client repeats `ids=` despite `explode: false`, an orval quirk, now harmless), **G18** (customer `kyc_consent` checkbox; `consent_at` shown read-only, never sent), **G20** (settlement bank picker = `GET /v1/companies/{id}/bank-accounts?q|ids`; `account_head_id` is a plain id under More details; customer `group_id` hidden and never sent). Also adapted: floors in import/export kinds; card-machine cash counter picker lists active counters only and a pathless 422 `inactive_master` shows on that field; vendor reveal `pan_not_migrated` → masked legacy PAN + "PAN not migrated yet".

Contract issues / still open:
- **C1** MastersPhone description says input "may carry spaces, dashes or +91", but the schema pattern rejects them, so a validating gateway/generated zod would 422 such input. The client normalises before sending; please either relax the input pattern or drop that sentence.
- **C2** Cash counters: there is no separate cash-counter master; `cash_counter_id` points at M12 `counters` (display counters). Confirmed by usage, please document. Departments and designations are free-text staff fields (no master, so no `is_active`) — the requested is_active toggles exist only for counters (generic Stop using / Activate).
- **C3** `POST /v1/masters/vendors/pan-backfill` is new (dry run by default); not wired in the UI yet (ops task) — say if the owner should get a button.
- **C4** Rates: 0.7.3 has no rate changes — no todays-status endpoint, no `rate_card` PrintDocType, no history `metal_id`, no batch publish. Rates R1–R5 above stay open; screens keep running on the mocks behind `features/rates/api.ts`.

## 0.7.4 (backend fdc49b6) — closed
- R1 todays-status: generated type; branch row or shop summary + branches[]; 404 unknown/inactive branch; old metal = warning only. CLOSED.
- R2 rate card: GET /v1/rates/rate-card, doc_type rate_card; card renders from it. CLOSED.
- R3 history: server metal_id filter; effective_to (exclusive) + Entered/Derived/Adjusted from derived_from_id / derived_rate_per_g. CLOSED.
- R4 save: POST /v1/rates/batch per kind with per-attempt Idempotency-Key; overrides under "Adjust a purity rate"; same-day correction needs rates.edit (button gated, friendly 403/422). CLOSED.
- R5 mock status rule = server R9 (sale rate dated today on an active purity, shop-wide or branch; no active metal = not set). CLOSED.
- C1 phones: server accepts unnormalised; client still normalises. CLOSED.
- C2 card_machine.cash_counter_id → accounts.cash_counter (till), no API: plain UUID field under More details with a hint; display-counter picker removed. CLOSED.
- R7 / R10: left for later as asked.
