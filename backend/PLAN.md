# Backend Plan: Jewellery Retail SaaS (v0.1, 20 Oct 2026)

Sources: `jewellery_saas_spec.md` (D1–D12), `jewellery_saas_architecture.md` (§4, §5, §11, §20), `jewellery-data-model/` (migrations 000–900, README v0.2, tests).
Stack: TypeScript, NestJS on Fastify, Drizzle (types and queries only; schema owned by the SQL migrations), pg-boss, PostgreSQL 16+ with tenant_id and forced RLS, pnpm with Turborepo. Scope is retail only; manufacturing and wholesale are excluded.
Status: v0.2 (20 Oct 2026). M0 foundation scaffolded locally in this folder (see §7). Nothing pushed, merged or deployed.

## 1. Monorepo layout (backend slice of arch §4)
```
apps/
  api/                 NestJS + Fastify modular monolith
    src/core/          tx context (AsyncLocalStorage), tenant resolver, authz guard, error model, outbox writer
    src/modules/<m>/   <m>.module.ts · public/ (facade + DTOs + event types) · internal/ (controllers, use-cases, repos) · db/ (Drizzle table defs for schema <m>) · tests/
  worker/              pg-boss consumers: outbox relay, notifications, PDFs, e-invoice, INV-6 recon, audit anchor, backups
  control-plane/       Platform + SaaS Billing entrypoint (signup, partner and tenant registry, licences)
packages/
  contracts/           OpenAPI 3.1 split by module → generated TS types, Zod, client (source of truth)
  domain/              pure TS: pricing, GST, weights (3 dp), purity, old-gold, rounding, FY
  shared/              amount-in-words registry (en, ta, hi, te, kn, ml), typed print-field formatter (native numerals)
  money/               decimal.js money (2 dp) / weight (3 dp) strings; never JS floats
  db/                  migration runner (plain SQL; imports jewellery-data-model/migrations as the base), roles, test DB harness
  config/              Zod config, feature flags, plan entitlements
  test-utils/          Testcontainers Postgres, factories, golden bills
  tooling/             eslint, dependency-cruiser rules, INV-2 forbidden-pattern guard, generators
```
Rules: modules import only `modules/<x>/public`. A module's Drizzle `db/` folder can be imported only by that module, enforced by dependency-cruiser in CI. There is one Postgres schema per module, as the data model already provides.

## 2. Module boundaries, interfaces and events
| Module | Owns | Facade (sync, joins caller tx) | Emits (outbox → pg-boss) | Consumes |
|---|---|---|---|---|
| Platform | partners, tenants, org tree, users, roles, settings, flags, audit, licences, branding, domains, print templates | `TenantContext`, `AuthZ.check(perm, branch)`, `Audit.record(evt)`, `Branding.resolve(host)`, `Templates.resolve(kind)`, `Settings.get()` | `UserChanged`, `PermissionChanged` | — |
| Masters | metals, purities, tax_rule, gst_config, items, stone standards, customers, vendors | `Masters.getItem()`, `Tax.ruleFor(component, metal, hsn, date)`, `GstConfig.at(date)`, `Parties.findCustomer()` | `MasterChanged` | — |
| Rates | metal, old-metal and carat rates (insert-only) | `Rates.current(branch, purity, kind)`, `Rates.at(ts)` | `RatePublished` | `ApprovalGranted` (rate publish) |
| Inventory | lots, tags, HUID, stock_ledger, transfers, stock-take | `Stock.validateSellable(tags, branch)`, `Stock.markSold()`, `Stock.receive()`, `Stock.transfer()`, `Stock.returnToStock()`, `Stock.oldMetalIn()` | `StockMoved` | `ApprovalGranted` |
| Sales | estimates, invoices, credit notes, returns, payments, doc_series | `Sales.issueInvoice()`, `Sales.cancelInvoice()`, `Sales.issueReturn()` | `InvoiceIssued`, `InvoiceCancelled`, `CreditNoteIssued` | — |
| Orders & Repairs | orders, karigar jobs, repairs | `Orders.receiveFinished()` → Stock.receive | `OrderReady`, `RepairReady` | `InvoiceIssued` (order closure) |
| Purchases | purchases, old-metal purchase vouchers, vendor settlement | `Purchases.post()`, `Purchases.oldMetalVoucher()` | `PurchasePosted`, `VendorSettled` | — |
| Refinery | bags, melt and purification issue/receipt, losses | via Stock | `MeltReceived`, `PurificationReceived` | — |
| Accounts | CoA, vouchers, ledgers (₹ and g), advances, suspense | none in the invoice path (ledger posting is async only) | `VoucherPosted` | `InvoiceIssued/Cancelled`, `PurchasePosted`, `VendorSettled`, ... (idempotent) |
| HR & Incentives | staff, slabs, targets | `Incentives.forPeriod()` | — | `InvoiceIssued/Cancelled` |
| Approvals | types, rules, requests, decisions | `Approvals.request()`, `Approvals.consume(id, subject)` | `ApprovalGranted/Denied` | — |
| Reports | read-only views; export jobs | `Reports.run()` (app_ro connection) | — | — |
| Notifications | outbox, templates, senders, delivery log | `Notify.enqueue()` (same tx) | — | all alert-worthy events |
| SaaS Billing | plans, subscriptions, entitlements, partner and white-label fees | `Entitlements.check()` | `SubscriptionChanged` | — |

Sync vs async: anything that must be atomic with an invoice runs synchronously in the same transaction: stock mark-sold, advance and credit-note redemption (done by Sales under sales_writer, guarded by the data model's DB triggers; there is no Accounts callable), approval consumption, the outbox insert, and the INV-5 alert row. Ledger posting, incentives, e-invoice/IRN and PDFs run asynchronously through the outbox with idempotent handlers keyed on event id.
Event delivery: a domain event is written to `notifications.outbox` in the producing transaction, and a relay publishes it to pg-boss (at-least-once). Each consumer keeps a dedup table.

## 3. Tenancy and RLS
- Roles come from `000_bootstrap.sql`. `app_rw` is the API login: NOBYPASSRLS and not the owner. `app_ro` serves Reports. `app_migrator` owns the schema and runs migrations. The NOLOGIN writer roles `sales_writer` and `inventory_writer` (plus the other module writers in 900_security) are taken with `SET LOCAL ROLE` inside the unit of work.
- Per request, the transaction interceptor opens a tx and calls `set_config('app.tenant_id'|'app.user_id'|'app.branch_id'|'app.partner_id', …, true)`. Settings are transaction-local, which is safe under PgBouncer transaction pooling. No query runs outside a tx; a lint rule plus a runtime guard throws if the tx context is missing.
- Tenant resolution: host → `Branding.resolve(host)` (verified domain or subdomain) in shared cloud, `TENANT_ID` config in dedicated, and the licence file on-prem. The session's tenant must match the host tenant (httpOnly server-side sessions in Postgres; no JWT).
- Branch scope: the API permission guard first, then a restrictive `branch_scope` RLS policy for branch-limited roles.
- Writer-role helper: `withModuleRole('sales_writer', fn)` lives only in Sales' internal code, and dependency-cruiser stops other modules importing it. The same applies to Inventory.
- Partner users can see only registry and billing data (arch §19 Q9 is still open).
- Tests: a cross-tenant leakage suite runs every module's repos under tenant A and asserts zero rows from tenant B.

## 4. INV-1..6 enforcement (DB vs service)
| Rule | Database (already in data model; tests pass) | Service / app layer | CI / tests |
|---|---|---|---|
| INV-1 gapless series per branch/FY | G1 counter only +1, no rewind or delete; G2 deferred trigger: an allocated number must be used before COMMIT; G3 doc_seq must equal the allocated number, fy = fy_of(doc_date), issued_at = now(); UNIQUE(tenant, branch, doc_type, fy, doc_no); separate CN series; estimates non-tax | `SalesService.issueInvoice` allocates with `UPDATE doc_series … RETURNING` inside the tx; no number or date field in the contract (client-supplied doc_date/doc_no → 422); doc_date = server date in Asia/Kolkata; online billing only; `Idempotency-Key` required | Concurrency test (50 conns), rollback mid-issue, gaps = 0 |
| INV-2 single bill path | app_rw has no INSERT on sales docs; only sales_writer can write; G4 children only in the issuing tx | One endpoint `POST /api/v1/sales/invoices`; GST computed server-side (packages/domain + Tax/Rates snapshots); client totals ignored or verified | Forbidden-pattern guard (`backup`, `truncate`, `shadow`, `alt_series`, `setNow`, `authenticatepass`, …); route inventory test asserts exactly one writer |
| INV-3 audit log | G6 `audit_append` + triggers, per-tenant hash chain, no UPDATE/DELETE/TRUNCATE for anyone; `audit_verify()` | `Audit.record()` for semantic events (print, reprint, login, export); worker anchors the chain head to the control plane daily | Chain-tamper test; verify on tenant import |
| INV-4 no deletion | G5 BEFORE DELETE/TRUNCATE for all roles; G3 update guard allows only issued→cancelled with a linked cancellation CN | `cancelInvoice` requires reason + `sales.invoice.cancel` permission; issues the CN, reverses stock (Inventory) and payments/advances (Sales, under sales_writer) in one tx | Owner-role bypass tests (already passing) |
| INV-5 cancellation alerts | **Recommend restoring one trigger** credit_note → outbox (see Q4) | Outbox row in the same tx; worker fans out in-app/push/WA/SMS/email per settings; daily summary + threshold escalation jobs | Test: a CN without an outbox row is impossible (if trigger) or a failing service test |
| INV-6 reconciliation | `sales.series_gaps` view (confirm it exists in 100/140) | pg-boss nightly job, must return 0; GSTR-1 doc-summary cross-check; owner dashboard | Job test with seeded gap via migrator-only fixture |

## 5. Build order (milestones)
- **M0 Foundations (1–2 wk):** monorepo skeleton, tooling and CI (lint, dependency-cruiser, forbidden-pattern guard), `packages/db` running the existing 000–900 migrations via Testcontainers, tx/tenant context, error model, OpenAPI pipeline (contracts → types/Zod), and the existing SQL test suite running in CI.
- **M1 Platform core + "issue one invoice end-to-end" (3–4 wk), the proposed first milestone:** contracts first, then tests, then code for Platform (tenant/branch/user/roles, AuthZ, Audit, Settings), Masters (metal, purity, item, customer, tax_rule, gst_config, read + minimal CRUD), Rates (publish/current), Inventory (tag create/receive, validateSellable, markSold), Sales `issueInvoice` (port of `tests/issue_invoice_uow.sql`) and `cancelInvoice` + CN, Notifications outbox + INV-5 alert worker (in-app/email stub), and the INV-6 nightly job. Exit criteria: golden-bill tests in `packages/domain`, the INV suite green, cross-tenant suite green, and a contract test for every route.
- **M2 Counter MVP:** estimates, old-gold exchange, advances/credit-note redemption (Accounts minimal), Approvals (min-price/wastage overrides), statutory checks (269ST, 114B), print templates/PDF worker, branding resolve, Reports views (day book, stock, GST summary).
- **M3 Back office:** Purchases + old-metal vouchers, Accounts ledgers via events, Orders & Repairs, HR & Incentives, transfers/stock-take.
- **M4 SaaS:** SaaS Billing, signup/control plane, partners/white-label, custom domains, licences, e-invoice/IRN.
- **M5:** Refinery, data import, tenant bundle export/import, on-prem updater hooks.

## 6. Open questions, gaps and conflicts
**Conflicts between docs (need a decision; recommend that the data-model v0.2 wins):**
1. **Where the logic lives.** Arch §4.1/§11 says invoice and stock writes go only through `SECURITY DEFINER` functions (`sales.issue_invoice(jsonb)`), and the INV-5 alert and DDL event triggers live in the DB. Data model v0.2 removed those in favour of app-layer logic with `SET LOCAL ROLE sales_writer/inventory_writer`, and also dropped the credit_note→outbox trigger and the DDL event triggers. The arch doc needs updating, and the owner should confirm. My recommendation: keep v0.2 but restore the INV-5 trigger (data-model Q4) and the DDL event trigger guard, or replace the latter with a CI migration-review gate.
2. Audit table naming: arch says `audit.event`; schema has `platform.audit_event`. The plan follows the schema.
3. ~~Accounts sync redemption facade~~ **Decided:** no Accounts DB function or callable. Sales redeems advances/credit notes inside its own tx under sales_writer, guarded by the data model's triggers; Accounts posts ledgers asynchronously from events.
4. ~~`customer_group` permission error~~ **Resolved:** that line is the *expected* outcome of the "app_ro is read-only" check (an INSERT attempted as app_ro). Not a bug; M0 integration tests assert it.
5. "Only Inventory mutates stock" vs Orders/Purchases/Refinery: all of them go through Stock facades, but the data model has writer roles only for sales and inventory. The writer-role list for the other modules needs confirming.

**Business/owner questions (blocking M1–M2):**
6. Old-gold valuation basis (stated purity vs 24K fine) and surplus handling (refund on bill vs mandatory purchase voucher).
7. GST defaults with CA: making composite vs separate; repair SAC; hallmark charge; whether advances are GST receipt vouchers.
8. ~~Money representation~~ **Decided:** DB numeric; wire = decimal strings ("1234.50"; weights "9.500"); decimal.js; no floats.
9. Multi-GSTIN tenants: series is per branch (GSTIN place of business). Confirm one branch = one GSTIN.
10. Silver HUID mandatory? Return window default (15 days)?
11. Brand name (needed for the forbidden-brand lint and default domain).
12. Partner data access (arch Q9) and whether partners manage tenants' print templates.
13. ~~Offline billing~~ **Decided:** no offline billing. No provisional receipts, no sold_at back-dating, no sync-order numbering.
14. ~~Auth~~ **Decided:** httpOnly server-side sessions in Postgres, password + optional OTP, no JWT. Design: `docs/auth-sessions.md`; table proposal `packages/db/proposed/session.sql` (needs a data-model migration).

## 7. Binding decisions (20 Oct 2026) and plan changes
- **Billing is online only.** Removed everywhere: offline "pending issue", provisional receipts, sold_at back-dating, sync-order numbering. `doc_date` = server date in Asia/Kolkata. Any client-supplied doc_date / doc_no / doc_seq → **422**.
- **Idempotent issue (M1).** `POST /api/v1/sales/invoices` requires `Idempotency-Key` (unique per tenant, retained 24h). Retry with same key + same payload (hash of canonical body) returns the original invoice; same key + different payload → 422. In `contracts/openapi.yaml`. Needs a data-model table (`sales.idempotency_key(tenant_id, key, request_hash, invoice_id, expires_at)`), requested from the data bot.
- **Redemption.** No Accounts callable / DB function. Sales redeems advances and credit notes in the issue tx as sales_writer, guarded by the data bot's triggers.
- **Language.** Tenant master setting with per-print override of language and numeral system. `packages/shared` holds a pluggable amount-in-words registry (decimal-string input). M0: registry + en-IN (lakh/crore, paise, zero). M1: ta, hi, te, kn, ml providers with reference test strings, all marked **needs native-speaker verification** (our own strings are not authoritative).
- **Native numerals** are a per-print option with a tenant default, applied ONLY to amounts, weights, quantities and dates. GSTIN, HUID, invoice numbers, phone numbers, barcodes (and PAN/HSN) always stay Latin: `formatField(kind, …)` in `packages/shared` enforces this by field kind (M0 stub done).
- **GST rates** are managed through contract-first settings CRUD APIs over `masters.tax_rule` / `masters.gst_config` (Masters module, M1), validated against the DB's non-overlap EXCLUDE and rate CHECKs; changes audited.
- **Onboarding status API (Platform, M1):** `GET /api/v1/platform/onboarding` returns per-tenant setup steps for the wizard (company+GSTIN, branch, users/roles, metals & purities, tax rules/gst_config, rates published, print template, language), each `{step, done, blocking, link}`, derived from live data (no separate flags to drift).
- **On-prem works on the LAN with no internet.** Nothing in the billing path may hard-depend on an external service (e-invoice/IRN, WhatsApp/SMS, PDF fonts, OTP delivery are async or optional with local fallbacks).
- **DevOps notes:** Gotenberg image must bundle Noto fonts for Latin, Tamil, Devanagari, Telugu, Kannada and Malayalam. The api image ships every `migrations/*.sql` (incl. `000_bootstrap.sql`) at `/app/migrations` (`MIGRATIONS_DIR` overrides); `node dist/migrate.js` runs as app_migrator; 000_bootstrap is a separate superuser step.
- **Worker / outbox.** apps/api never uses pg-boss (lint-enforced); it inserts `notifications.outbox` rows in its own tx. apps/worker (app_worker) claims rows `FOR UPDATE SKIP LOCKED`, enqueues pg-boss jobs (schema `pgboss`) on the same connection, and marks rows sent, all in one tx. app_rw has no access to `pgboss`.

## 8. M0 status (built locally)
See `README.md` in this folder for layout, commands and results.

## Status 24 Oct 2026 — Platform module (scope narrowed to Platform only)
Done: contract v0.2.0 (`contracts/openapi.yaml`, Redocly clean) → integration tests (`tests/integration/platform.test.ts`) → code
(`packages/modules/platform`, wired in `apps/api`). Auth/sessions per `docs/auth-sessions.md`; onboarding uses the data model's
`platform.onboarding_step` progress table (stored, not derived — supersedes line 101 above). Not built by instruction: custom roles,
sender IDs, data export, offline billing. Import: customers only (stock/opening_balances → 422 until their modules ship).

## Status 24 Oct (Platform module), after steering
- Mirage's platform-ext draft is merged into contracts/openapi.yaml. contracts/MERGE-NOTES.md lists every change; Redocly lint is clean.
- Onboarding billing gate now reads platform.v_billing_unlocked (5 steps), with an integration test.
- Re-migrated and re-introspected (scripts/db-pull.sh). Lint, typecheck, unit tests and integration tests (57/57) are green.


## Schema v1.4 adoption (24 Oct 2026). Written, NOT run (no-run rule from Adithya, 9:48 AM IST)
- [x] Contract 0.3.0: If-Match/ETag (412/428), partner sessions and users, mapping profiles, import errors, bill_series_prefix, slimmer TenantCreate, PartnerTenant
- [x] Code: DB admin/partner sessions, provision_tenant(), resolve_tenant(), OTP via otp_delivery and the worker, versioned updates, import of all three kinds
- [x] Tests edited (unit + integration)
- [ ] On the VPS: pnpm install (new workspace deps), redocly lint, tsc, vitest unit + integration; fix whatever fails
- [ ] Schema requests (see the final report / MERGE-NOTES)
