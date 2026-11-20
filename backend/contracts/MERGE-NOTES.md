# Merge notes: frontend/contracts/platform-ext.draft.yaml → backend/contracts/openapi.yaml

`openapi.yaml` is the single source of truth, and the draft was not edited. Regenerate clients from `openapi.yaml` only.
Rules applied: P1–P23, the data-model schema as-is, decimal-string money, `application/problem+json` errors, cookie sessions,
no custom roles, no data export, no sender IDs, no offline billing.

## Global changes
| Draft | Merged | Why |
|---|---|---|
| `/v1/platform/*` prefix | flat `/v1/*` (existing implemented paths) | The paths are already implemented and tested, and one prefix scheme is used across modules |
| `#/components/responses/Problem` | specific responses (`BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`, `Unprocessable`, `TooManyRequests`); `Problem` kept as an alias | Same `Problem` schema. Error codes live in `Problem.code` |
| `Scope` query param (tenant/partner) | removed. Partner surfaces use `/v1/partner/*` (`X-Partner-Key`), operators use `/v1/admin/*` (`admin_sid`) | The session decides the scope. A query param must not select the RLS context |
| `Money` `^-?\d{1,12}\.\d{2}$` | `Decimal` strings as in the existing contract | Same convention as everything else; no separate type |
| `Locale en-IN/ta-IN`, `Numerals latn/taml` | `LanguageCode` (`en`/`ta`), from the schema | DB values |
| `If-Match` / `version` on shop profile | **adopted** (v1.4+) | tenant, company and branch carry `version`. `PATCH /v1/tenant` (default_language only) needs `platform.settings.edit` (owners have it by default) and If-Match on tenant `version`; audited as `tenant.default_language_changed` |

## Path by path
| Draft path | Merged as | Notes |
|---|---|---|
| `GET /meta` | **added** `GET /v1/meta` (public) | `deployment_mode` enum is `shared/dedicated/onprem` (schema value, not `on_prem`) |
| `GET /branding/resolve?host` | `GET /v1/branding/theme` (host is taken from the `Host` header) | Returns the merged theme (platform→partner→tenant). It does not return a raw `layers[]` array, `radius_px`, a WCAG flag or `version` |
| `GET /me` | `GET /v1/auth/session` + `GET /v1/users/me` | `Session` has `roles[]` (role + branch scope), `permissions`, `billing_enabled` (approved device, P10), **new** `billing_unlocked` (onboarding gate). No `surface`; partner and admin are separate APIs |
| `PATCH /me/preferences {locale_override}` | `PATCH /v1/users/me` `{language}` (null = shop default) | Corrected in v1.4: this was listed as PUT earlier, but it is PATCH; it now needs If-Match |
| `GET/PUT /shop-profile` | `GET /v1/tenant` + `/v1/companies[/{id}]` + `/v1/settings/*` | The shop profile is split across the tenant, company (GSTIN/PAN/state) and settings tables. `idle_timeout_minutes` and `pan_required_above` are settings keys |
| `/branches` (`bill_series_prefix`) | `/v1/branches` | `bill_series_prefix` dropped (doc numbers are server-assigned, P-doc-number). `effective_gstin` not returned |
| `/devices` `{name, branch_id}` | `/v1/devices` `{name, kind, branch_id, device_key}` | `kind` enum and `device_key` (≥32) are required by the schema and P10 |
| `GET /devices/current` | **added** `GET /v1/devices/current` | Device bound to the session; 404 `no_device` |
| `POST /devices/{id}/approval`, `/revocation` | `POST /v1/devices/{id}/approve`, `/revoke {reason}` | Existing verbs |
| `/roles` with `partner_admin`, `platform_admin` | `/v1/roles` (fixed tenant roles only, read-only) | No custom roles. Partner and platform operators are not tenant roles |
| `/users` `otp_required` | `/v1/users` | `otp_required` dropped (no column). OTP policy is a tenant setting. Role changes go through `PUT /v1/users/{id}/roles` |
| `/branding/profile` (`logo_url`, `icon_url`, `radius_px`) | `GET/PUT /v1/branding/theme` (+ `/v1/partner/branding/theme`) | Logo upload is multipart to the file store. `radius_px` is accepted only as a theme token |
| `/domains` (`cname_target`, `txt_name`, `txt_value`, `pending_dns`, `cert_status`) | `/v1/branding/domains` (`verification_token`, `status` from the schema), `POST …/verify`, `GET /v1/internal/tls/ask` | Uses the schema's field names and status values. Certificates are issued on demand (Caddy ask), so there is no `cert_status` |
| `/print-templates` kinds `tax_invoice…`, `a4/thermal_80`, `bilingual`, status `draft/published/retired`, `POST …/publication` | `/v1/print-templates`, `POST …/activate` | Kinds, paper and status come from the schema. The server-side GST field lint (`template_lint_failed`) is deferred because template bodies are file-store objects |
| `/audit-events` `q, action, from, to, cursor`, `chain_verified` | `/v1/audit-events` (filters + cursor) and a separate `POST /v1/audit-events/verify` | Hash-chain verification is a separate, explicit call |
| `/import/templates` | `GET /v1/import-templates/{kind}` (CSV/XLSX file) | |
| `/import/profiles` (mapping profiles) | not adopted | No storage in the schema. Column mapping is sent with each import |
| `POST /import/jobs` (JSON rows, `stock_tags`) | `POST /v1/imports` (multipart CSV/XLSX, `dry_run`) | Customers only for now. Stock is owned by Inventory, not Platform |
| `POST /import/jobs/{id}/commit` | `POST /v1/imports/{id}/commit` (Idempotency-Key) | |
| `GET /partner/tenants` (counts) | `GET /v1/partner/tenants` | Registry fields only, with no sales, stock or customer data and no counts |
| `GET /partner/billing` (statements in Money) | `GET /v1/partner/billing/subscriptions` | Only subscriptions exist in the schema. Amounts are decimal strings |
| `/admin/tenants` `AdminTenantInput {plan, owner_login}` | `POST /v1/admin/tenants` (company, branch, owner) | Plan assignment goes through subscriptions. Usage is not exposed |
| `PUT /admin/tenants/{id}/status {status, reason}` | `POST /v1/admin/tenants/{id}/suspend {reason}`, `/reactivate` | |
| `/admin/partners` | `/v1/admin/partners`, `PUT …/{id}/status` | |

## Onboarding (steering)
`Onboarding` gained `billing_unlocked`, `missing_billing_steps` and `steps[].required_for_billing`. These are read from `platform.v_billing_unlocked`.
The gate is exactly `shop_profile, gst, metals_purities, gst_rates, todays_rates`. Branches and print templates never block billing.

## v1.4 (schema 1.4) changes (contract 0.3.0, 24 Oct 2026)
> Status: written under the no-run rule (no redocly lint, tsc or tests on this box). It will be linted and verified on the VPS.

**Concurrency decision (lead mentioned 409/412):** we use **412 + 428**, not 409.
- Versioned resources return `version` in the body and `ETag: "<version>"`.
- Edits must send `If-Match: "<version>"`. A missing header returns **428 `precondition_required`**; a stale version returns **412 `version_mismatch`**.
- **409** stays for uniqueness and state conflicts. A 409 for staleness would blur "someone else edited this" (reload and retry) with "this value is taken" (change your input).
- The DB is the guard: `UPDATE … WHERE id=$1 AND version=$2`; the aa_version trigger bumps the version.
- Covered: PATCH tenant, companies/{id}, companies/{companyId}/bank-accounts/{id} (and DELETE), branches/{id}, users/{id}, users/me, admin/tenants/{id}, partner/users/{id}, import-mapping-profiles/{id} (and DELETE).
- Conditional (If-Match required only once the row exists): PUT/DELETE settings/{key}, PUT branding/theme, PUT partner/branding/theme. The first save creates the row.
- Exempt, because their state checks guard them: device approve/revoke, domain verify, tenant suspend/reactivate, partner status.
- **Exception: `POST print-templates/{id}/activate` KEEPS If-Match**, on the template's `row_version` (not `version`, the document version). Activating swaps the active template of a kind, so a stale view must not win.
- Every operation that needs If-Match declares `components/parameters/IfMatch` (or `IfMatchOptional` for the conditional upserts) so Orval generates the header.
- Every 429 is problem+json with `code: rate_limited` and a `Retry-After` header (seconds). Login lockout stays 401 `invalid_credentials` (no account enumeration).
- Note: app_user.version also bumps on login-counter updates (failed_logins). A client holding an old user version gets 412 and must reload.

| Area | Before | v1.4 |
|---|---|---|
| Partner auth | `X-Partner-Key` header (env PARTNER_API_KEYS) | `POST /v1/partner/auth/login {partner_id \| partner domain Host, email, password}` sets cookie `psid` (Path /api/v1/partner, 12 h absolute, 30 min idle), stored in `platform.partner_session` as sha256. Also `logout` and `GET auth/session`. Security scheme `partnerKey` is replaced by `partnerSession` |
| Partner users | none | `GET/POST /v1/partner/users`, `PATCH /v1/partner/users/{id}` (partner_admin only; deactivation revokes sessions). First admin: `POST /v1/admin/partners/{id}/users` |
| Partner shops | `GET /v1/partner/tenants` returned `Tenant[]` via the admin pool | Returns `PartnerTenant[]` from `v_partner_tenant_directory` (`tenant_id, display_name, tenant_status, plan_code, plan_name, subscription_status`). **Breaking:** the field is `tenant_id`, not `id` |
| Admin session | HMAC-signed cookie | Opaque token; sha256 stored in `platform.platform_admin_session`; logout sets `revoked_at` |
| Provisioning | Two pools, not atomic | One `platform.provision_tenant()` call. `TenantCreate` keeps `deployment_mode` (default `shared`; `provision_tenant()` takes it as `p_deployment_mode`) and drops `status` (always trial), `company.trade_name/address`, `owner.email` and `branch.state_code` (strict, so 422 if sent) |
| Tenant login | Slug looked up via the admin pool | `platform.resolve_tenant(slug)` as app_rw |
| OTP | Code in the outbox payload; sha256 hash | `code_hash` = HMAC-SHA256 (32 bytes). Code stored only as AES-256-GCM ciphertext in `platform.otp_delivery`. Outbox payload `{delivery_id, challenge_id, channel, to}`. The worker's `deliverOtp()` deletes, decrypts and sends; expired rows are deleted unsent. OTP requests are limited to 3 per user per 15 min (counted from otp_challenge), else 429 |
| Branch | `bill_series_prefix` absent | Required on create (`^[A-Z0-9][A-Z0-9/-]{0,11}$`), editable, returned |
| Versions | — | `version` on Tenant, Company, Branch, User, Setting (nullable), ThemeView (nullable), ImportMappingProfile, PartnerUser |
| Import | Customers only; errors in a JSON file | customers (+`pan` → `pan_enc` + `pan_last4`), stock (→ inventory.tag; `branch_id` required), opening_balances (→ account_head opening_*). Errors in `platform.import_row_error` (`code` added to each error) + `GET /v1/imports/{id}/errors`. Upload takes `profile_id`. Templates are now v2 (stock/opening columns changed) |
| Mapping profiles | — | `GET/POST /v1/import-mapping-profiles`, `GET/PATCH/DELETE /v1/import-mapping-profiles/{id}` |
| Problems | — | New responses `PreconditionFailed` (412) and `PreconditionRequired` (428) |

## v1.9 (data model 950 platform.language)
- Language codes are FK-validated against `platform.language` (en, ta, hi, te, kn, ml): `PATCH /v1/tenant` and `PATCH /v1/users/me` pre-check; any other write hitting a `*_language_fk` / `template_locale_fk` FK maps to **422 `unknown_language`**.
- **Added** `GET /v1/meta/languages` (public): `[{code, name, native_name}]` for Mirage's language pickers.
- 970: the dry run writes the applied mapping to `import_job.mapping_snapshot` (`{}` without a profile); commit uses ONLY the snapshot (never re-reads the profile) and copies it to the completed job. `ImportJob.mapping_snapshot` added (read-only). A pre-970 dry run without a snapshot → 409 `dry_run_outdated`.
- `TenantCreate.branch.bill_series_prefix` (optional, same pattern/length as Branch; default = code). Superseded by 971: passed as `p_bill_series_prefix` inside provision_tenant (atomic); see v0.4.1.
- 429: Retry-After is always sent; clients may fall back to 30 s if it is missing.
- Removed the unused `components/responses/Problem` alias (redocly no-unused-components).

## v0.4.0 — masters/rates + meta version
- New: POST /v1/masters/metals, PATCH /v1/masters/metals/{id}, POST /v1/masters/purities, PATCH /v1/masters/purities/{id} (platform.settings.edit). No If-Match: metal/purity have no version column.
- POST /v1/rates (rates.publish) is insert-only; rate_date = IST today. There is no PUT because app_rw has no UPDATE on rates.metal_rate. GET /v1/rates/current: branch_id is now optional.
- BREAKING: Purity.fineness is now a decimal string (numeric(6,3)), not an integer.
- Writes mark platform.onboarding_progress: metals_purities (once a purity exists) and todays_rates (on publish), via markOnboardingStepCompleted in the platform facade.
- /v1/meta api_version comes from info.version through scripts/gen-contract-version.mjs (runs in the mod-platform build). turbo globalDependencies now includes contracts/openapi.yaml. min_client_version is 0.3.0.

## v0.4.1 — 971 provision_tenant(p_bill_series_prefix)
- The console passes the prefix as the named argument `p_bill_series_prefix => $16`. The second-transaction fallback is gone, so provisioning is fully atomic (this replaces the earlier schema request).
- TenantCreate.branch.bill_series_prefix is no longer pattern-checked by the client schema. The DB upper-cases and validates it; 23514 'invalid bill series prefix' → 422 `invalid_bill_series_prefix`.
- The 201 response is now `TenantCreated` (Tenant + `branch {code, bill_series_prefix}`), re-read from the DB so it holds the stored value.

## v0.4.2 — Mirage notes
- New `GET /v1/rates`: rate history, read-only, open to any signed-in user (same as /rates/current). Filters: purity_id, kind, branch_id, from/to (rate_date, IST, inclusive). Newest first (effective_from DESC, id DESC). Uses the standard Limit/Cursor params; returns `MetalRatePage {items, next_cursor}` with an opaque keyset cursor (a bad cursor → 422 `invalid_cursor`).
- listPurities `metal_id` now has a description.
- Duplicate metal or purity code → 409 problem code `duplicate_code` (new response `DuplicateCode`; was `already_exists`).
- 972 versioning: masters.metal/purity gain `version` (aa_version trigger) and `is_active`. PATCH /v1/masters/metals/{id} and /purities/{id} require If-Match (428 missing, 412 stale, 404 unknown) and use `UPDATE ... WHERE id AND version`; version is never written by the app. Responses include version, is_active and an ETag (also on 201).
- Deactivation = PATCH {is_active:false} (and {is_active:true} to restore). GET lists hide inactive rows unless `include_inactive=true`.
- 422 `inactive_master`: creating a purity under an inactive metal, or publishing a rate for an inactive purity. Lead decision: GET /v1/rates/current omits deactivated purities and purities under a deactivated metal; GET /v1/rates history keeps them; POST /v1/rates for an inactive purity stays 422 `inactive_master`.

## v0.4.3

**GST settings (wizard steps 2 `gst` and 5 `gst_rates`, settings → tax page).** `/v1/settings/gst-config` (GET, POST),
`PATCH /v1/settings/gst-config/{id}`, `/v1/settings/tax-rules` (GET, POST) and `PATCH /v1/settings/tax-rules/{id}` were already
in the contract since 0.4.0 ("GST settings + M1 surface") but had no implementation, hence the 404s. They are now implemented
in the masters module (`tax-settings.controller.ts`) over `masters.gst_config` / `masters.tax_rule`, schema used as-is:
- Tenant RLS applies; tax-rules GET returns platform defaults + the shop's own rules (`scope`), POST always creates `scope=tenant`.
- Writes need `platform.settings.edit`. POST gst-config marks onboarding `gst`; POST tax-rules marks `gst_rates`.
- No If-Match: neither table has a `version` column and the contract never declared one. Rows are effective-dated:
  a change = close (PATCH `effective_to`) + create. Closing a platform rule → 403 `platform_rule`.
- Overlapping periods (DB EXCLUDE, 23P01) → 409 `overlapping_period`; CHECKs / tax_rule_guard (no back-dating,
  CGST+SGST=rate=IGST, composite ⇒ principal) → 422; unknown company_id → 422 `unknown_company`.
- Contract ↔ column mapping (SQL aliases only): `tax_inclusive`↔`tax_inclusive_pricing`, `round_off_unit`↔`round_off_to`,
  `b2c_qr`↔`b2c_qr_required`.

**Contract corrections (breaking on paper only — the routes never worked):**
- `GstConfigInput.making_treatment` removed: there is no such gst_config column; making-charge GST treatment is
  `SalesPolicy.making_gst_treatment` (`/v1/settings/sales-policy`). Sending it → 422.
- `round_off_unit` is now `enum ['0.01','0.10','0.50','1.00']` (DB CHECK) instead of Money.
- `TaxRuleInput.principal_component` is `enum [metal, service]` (DB CHECK), not TaxComponent.
- `GstConfig` / `TaxRule` responses are now explicit objects (nullable fields typed); TaxRule gains `in_use` (first_used_at set).
- 403 added to the write routes.

**`GET /v1/devices/current`:** an unregistered browser now gets `200` with body `null` (schema `oneOf [Device, null]`);
the 404 response is removed.

No data-model schema changes are needed.

## v0.4.4

**Atomic replace (new):** `POST /v1/settings/gst-config/{id}/replace` and `POST /v1/settings/tax-rules/{id}/replace`.
- One transaction: the old row is locked (`SELECT … FOR UPDATE`), `old.effective_to := new.effective_from`, the new row is inserted;
  201 `{replaced, created}`. Periods are `[from, to)`: `effective_to` is **exclusive** in the data model (EXCLUDE on
  `daterange(from, to) &&`), so the end is set to the new start date itself, **not** minus one day. That gives no gap and no
  overlap, so billing sees exactly one row on every date. Any failure, such as an overlap with a later period, rolls everything back.
- Inherited from the old row: `company_id` (gst-config) and `component` + `metal_code` (tax rules, the key billing looks up), so a
  replace can never move the lookup key and leave a gap. Sending those fields → 422.
- `Idempotency-Key` is required (422 `idempotency_key_required`), the same as import commit. The replay is natural: the same body after
  success → 200 with the same pair. If the row was already replaced by a different successor → 409 `already_replaced`.
  Limitation: keys are not stored (the data model has only `sales.idempotency_key`, which is invoice-specific). So "same key,
  different body → 422 idempotency_key_reused" cannot be detected. A different body yields 409 `already_replaced` instead.
  **Lead decision (12:31):** a generic `platform.idempotency_key` table is coming as **migration 973 (Perceptor)**. Once 973 lands,
  replace will return the standard **422 `idempotency_key_reused`** for a reused key with a different body. The code is ready:
  `claimIdempotencyKey(key, scope, requestHash)` in `tax-settings.controller.ts` is already called with a stable request hash
  in the replace transaction. It is a marked TODO no-op, and only that function changes once 973's real column names are known.
- Errors: 404; 403 `platform_rule` (tax rules); 409 `overlapping_period` / `already_replaced`; 422 `effective_from_in_past`,
  `invalid_period` (start ≤ old start, or start after an already-set old end, which would leave a gap), `rule_in_use`, and DB CHECKs.

**Frontend notes:**
1. New response `OverlappingPeriod` (409, code `overlapping_period` | `already_replaced`) on both POSTs, both close PATCHes and
   both replaces.
2. Date rules (IST): create/replace `effective_from >= today` (422 `effective_from_in_past`). Close `effective_to >= today`
   (422 `effective_to_in_past`) and `> effective_from` (422 `invalid_period`). Both PATCHes use the `PeriodClose` schema.
   tax_rule has these rules in the DB trigger. **gst_config has no such DB rule (only CHECK to > from), so the API now enforces
   start ≥ today and end ≥ today for gst-config.** This is new behaviour; back-dated gst-config POSTs now return 422.
   **Lead decision (12:31): kept.** The contract states that tax settings (gst-config and tax-rules) cannot be back-dated.
3. `in_use` (`first_used_at` set by the DB when an invoice line or line-tax references the rule) blocks every change except closing
   an open rule (`effective_to` null → date ≥ today). It also blocks moving an end date once set (422 `rule_in_use`) and delete
   (FK RESTRICT). It does not block closing an open rule or replacing an open rule.
4. Platform-owned gst_config cannot exist: `tenant_id` is NOT NULL and the PK is (tenant_id, id). Only tax_rule and sales_policy have
   platform scope.
5. `b2c_qr` is in every GstConfig response (required since 0.4.3).
6. A tenant rule reusing a platform rule's code does not overlap. `code` is neither unique nor part of the EXCLUDE key. The key is
   owner (tenant_id, or a zero-uuid for platform) + component + metal_code + hsn_sac + daterange, and platform and tenant rows
   always differ in owner. So both can be live on the same day.
   **Lead decision (12:31), precedence for the M1 pricing engine:** when a shop rule and a platform rule are both live on the same
   day for the same component + metal_code + hsn_sac, **the shop rule wins**. Never sum them or pick by code. This is recorded in
   the listTaxRules/createTaxRule descriptions.
   Same shop, same component/metal/HSN, overlapping dates → 409, whatever the code.

### v0.4.4: idempotency store wired (migration 973 delivered)
- Replace endpoints use `platform.idempotency_key` with scope = route template (`POST /v1/settings/{gst-config|tax-rules}/{id}/replace`),
  request_hash = sha256 hex of path id + canonical body. The table runs on the request transaction as **app_rw** (the masters
  controllers never SET ROLE).
- Design: SELECT first, so a sequential replay returns without touching business rows. Otherwise the business write and the INSERT of
  the key row (final status + body) run in one SAVEPOINT. A concurrent duplicate gets 23505: the savepoint undoes its write, the
  tx stays usable, and it answers from the winner's stored row. Same hash → stored status/body (201); different → **422
  `idempotency_key_reused`** (now live, replacing the earlier "after 973" note).
- Expired rows: 973 (updated) grants app_rw DELETE, limited by policy `rw_delete_expired_only` (expires_at <= now()) + tenant_isolation.
  An expired key is deleted (`WHERE scope AND key AND expires_at <= now()`) and re-stored in the same transaction, so the key
  can be reclaimed. A live or foreign row is deleted 0 times. Tested.

### Post-0.4.4 (description only; ships with the next release, version not bumped)
- Replace inputs (GstConfigReplaceInput, TaxRuleReplaceInput) DO accept an optional `effective_to`. It was in the schema and
  implemented in 0.4.4. Documented now: omitted → the replacement is open-ended (usual case); to end it later use the close PATCH;
  if given it is the new period's exclusive end and must be > effective_from.

### v0.5.0: object storage (S3 / Garage) and signed download links
- Includes the Post-0.4.4 description fix above.
- StorageService (put / get stream / delete / head) with two drivers chosen by `STORAGE_DRIVER=local|s3` (default `local`):
  LocalDiskDriver (current behaviour, `FILE_STORE_DIR`; content type in a `<key>.meta.json` sidecar) and S3Driver
  (@aws-sdk/client-s3, `forcePathStyle: true`, for Garage). Env is validated at boot; errors name variables, never values.
- New object keys: `<tenant_id>/<area>/<uuid>` (area: imports). Old local keys `imports/<tenant>/<sha256>.<csv|xlsx>` are still
  read (commit of an older dry run). Uploads no longer dedupe by content hash. Moving existing local files into Garage is a
  separate ops step (copy each file to the same key in the bucket) and is not done by the API.
- The import controller reads and writes only through StorageService. A dry run whose stored file is gone → commit 409 `import_file_missing`.
- `GET /v1/files/{id}/url` (platform.import.run): `{id}` = import job id, checked under RLS (another shop → 404). Returns
  `{ url: "/files/<token>", expires_at }`. Token = base64url(payload).base64url(HMAC-SHA256), payload has purpose
  `file_download`, tenant, job id, object key and expiry (5 min). Signed with `FILE_TOKEN_SECRET`.
- `GET /files/{token}` (site root, not /api; no session): constant-time signature check, purpose, expiry (expired → 410
  `link_expired`; bad → 404), then the job row must still exist with that key under the token's tenant (RLS) before the object
  is streamed. Headers: content-type, `attachment` disposition, `Cache-Control: no-store`, nosniff.
- Ops: Caddy proxies ONLY `/files/*` (besides `/api/*`) to the API; Garage's S3 port stays private.
- Pending schema request (not invented): a generic `platform.file` table (see below) so other areas can store files with a real
  original filename / size / content type. Until then downloads cover import uploads only and the filename is `import-<id>.<ext>`.
- Schema request (data bot), proposed migration 974: `platform.file(tenant_id uuid NOT NULL REFERENCES platform.tenant(id),
  id uuid NOT NULL DEFAULT platform.uuid_v7(), area text NOT NULL CHECK (area IN ('imports','exports','attachments')),
  object_key text NOT NULL, original_name text NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
  content_type text NOT NULL, size_bytes bigint NOT NULL CHECK (size_bytes >= 0), sha256 bytea, created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, PRIMARY KEY (tenant_id, id), UNIQUE (object_key))`;
  ENABLE + FORCE RLS with the usual tenant_isolation policy (tenant_id = platform.current_tenant()); app_rw SELECT, INSERT,
  UPDATE(deleted_at) (no DELETE); app_migrator owner. Optional: `platform.import_job.file_id uuid` with FK (tenant_id, file_id)
  → platform.file. Until delivered, nothing uses it.

### v0.5.1: platform.file wired (migration 974 delivered)
- Upload (dry run) writes the object, then in the request transaction INSERTs `platform.file` (area 'imports', object_key = the
  storage key, original_name = sanitised base name (control chars dropped, ≤ 255 code points), content_type, size_bytes,
  sha256 = 32 raw bytes, created_by) and the import job with `file_id` and `file_key` = object_key (still NOT NULL). If any of
  that fails, the object is deleted (best effort) before the error is returned. Commit jobs copy the dry run's file_id.
- ImportJob gains read-only `file_id` (null for older jobs).
- `GET /v1/files/{id}/url`: platform.file by id (deleted_at IS NULL) first; else an import job id → its file_id's row, or for a
  legacy job without file_id its file_key. Tokens now carry `s` ('file' | 'job'), the tenant and that id (plus the bound key);
  tokens without `s` are read as 'job'.
- `GET /files/{token}` re-resolves under the token tenant's RLS (deleted_at IS NULL) and requires the same object key; a file
  soft-deleted after the link was issued → 404. Content-Disposition: `attachment; filename="<ASCII fallback>";
  filename*=UTF-8''<RFC 5987>` built from original_name (quotes, backslashes, CR/LF and non-ASCII never reach the header raw).
- Not done (no endpoint asked for): soft-deleting files via the API.

### Post-0.5.1: storage orphan sweep (worker; no API/contract change, version not bumped)
- Storage drivers moved to the new package `@jw/storage` (API re-exports them; behaviour unchanged) and gained `list(prefix)`
  (local: directory walk, sidecars skipped; S3: ListObjectsV2 following ContinuationToken).
- pg-boss job `storage-orphan-sweep` in apps/worker, as app_worker, scheduled `17 * * * *` (Asia/Kolkata). Deletes an object
  only if ALL hold: key is in the imports area (`<tenant>/imports/<uuid>` or legacy `imports/<tenant>/<sha>.<ext>`; other areas
  are never touched), last-modified older than the grace period, and no platform.file row (soft-deleted ones count as references)
  and no import_job.file_key / error_report_key references it. Bounded per run. Logs one JSON line of counts, never keys.
- Fail safe: listing error, reference-check error, or the worker lacking a cross-tenant SELECT policy + column grants → nothing
  is deleted (status `list_failed` / `reference_check_failed`). Today app_worker has NO access to either table, so the job runs
  but deletes nothing until schema request 975 lands.
- Worker env: ORPHAN_SWEEP_ENABLED (default on; `0` = not scheduled), ORPHAN_SWEEP_DRY_RUN (default `1`: counts only; `0` to
  delete), ORPHAN_SWEEP_GRACE_HOURS (default 24, min 24, max 2160), ORPHAN_SWEEP_BATCH (default 500, max 5000 deletions per run),
  ORPHAN_SWEEP_MAX_SCAN (default 50000 objects listed per run), ORPHAN_SWEEP_CRON (default `17 * * * *`), plus the same storage
  env as the API: STORAGE_DRIVER, FILE_STORE_DIR (local; must be the API's directory) or S3_ENDPOINT/S3_REGION/S3_BUCKET/
  S3_ACCESS_KEY/S3_SECRET_KEY.
- Schema request 975 (data bot): app_worker read access to object references only, all tenants, no PII columns:
  `GRANT SELECT (object_key) ON platform.file TO app_worker;`
  `GRANT SELECT (file_key, error_report_key) ON platform.import_job TO app_worker;`
  `CREATE POLICY worker_ref_read ON platform.file FOR SELECT TO app_worker USING (true);`
  `CREATE POLICY worker_ref_read ON platform.import_job FOR SELECT TO app_worker USING (true);`
  (no_partner_access stays: current_partner() is NULL for the worker.) The worker checks for these grants and a permissive
  `USING (true)` SELECT policy for its role before trusting an empty answer, because RLS without a policy returns zero rows.
  Alternative if column grants + policy are unwanted: a SECURITY DEFINER `platform.storage_keys_referenced(p_keys text[]) RETURNS
  SETOF text` (owner with BYPASSRLS, `SET search_path = pg_catalog, platform`, max 5000 keys, EXECUTE to app_worker only); the
  worker would then call it instead.
