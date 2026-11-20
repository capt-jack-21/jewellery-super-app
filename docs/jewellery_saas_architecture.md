# Jewellery Retail SaaS — Architecture and Tech Stack

**Owner:** Adithya Venkatesh A (Coimbatore, India)
**Document status:** Draft v0.4, 20 Oct 2026. Companion to *Product Specification v0.6* (`jewellery_saas_spec.docx`) and the authoritative *Data Model v0.2* (`/workspace/jewellery-data-model`). v0.2 added owner decisions D11 (white-labelling, Section 20) and D12 (14 functional NestJS modules, Section 4.1). v0.3 adds decisions D13–D28 made by the master bot on 20 Oct 2026 (Section 1.1): retail-only scope, self-managed PostgreSQL 17, app-layer writes through per-module writer roles (no `sales.issue_invoice()` SECURITY DEFINER), SQL-first migrations, money/rounding, auth, offline-bill numbering, dev environment and bot team. v0.4 records the owner's overrides and accepted decisions D29–D37 (Section 1.2): **no offline billing**, language as a master setting with per-print language, GST rates in settings, a guided 10-step onboarding wizard, outbox reference columns, per-line tax rounding, the single allowed invoice change, configurable INV-5 thresholds, and the outbox → pg-boss relay.
**Scope:** target architecture for a brand-new system. The legacy React app (`billing_frontend-main`) is a **feature reference only**. No code, UI or API shape is carried over by default.

## How to read this document

- **Decision** = confirmed by the owner (listed in Section 1).
- **Recommendation** = proposed by this document, to be accepted or changed through an Architecture Decision Record (ADR).
- All prices are **indicative**, taken from public web pages on or around 20 Oct 2026 (sources in Section 18). They exclude GST unless stated. **Verify before you buy.** Cost figures are **estimates** built on stated assumptions.

---

## 1. Owner decisions this architecture must satisfy

| # | Decision |
|---|---|
| D3 | Brand-new backend in **Node.js** (no original backend exists). |
| D4 | **PostgreSQL** is the database. |
| D5 | **Completely redesigned frontend**: fresh look, nothing like the old AuSales UI. The old app is a feature reference only. |
| D6 | **Three deployment modes from one codebase:** (a) on-premise on a shop's own server/PC, possibly with poor internet; (b) shared multi-tenant cloud; (c) dedicated cloud instance per customer. |
| D7 | **Cloud-agnostic:** Docker, and no proprietary managed services in the core. The provider is undecided. |
| D8 | **Extremely low running costs** (Indian jewellers are price-sensitive). |
| D9 | **SMS and WhatsApp:** cheapest viable Indian options behind a **pluggable provider interface**. |
| D10 | Built **mostly by AI coding agents**: strong conventions, typed contracts, high test coverage. |
| D11 | **White-labelling is required:** a partner/reseller level above tenants; per-tenant branding (app name, logos, colour tokens, fonts, login page, PWA manifest/icons per host); custom domains with automatic TLS; versioned per-tenant print templates; per-tenant WhatsApp/SMS/email senders; branding resolution **tenant → partner → platform default**; full rebrand for dedicated/on-prem; a white-label fee as a pricing option. **Rule: no hard-coded brand or colours in the frontend; a design-token system exists from day one.** |
| D12 | **14 functional NestJS modules**, each owning its tables and routes and talking to others only through services: Platform, Masters, Rates, Inventory, Sales, Orders & Repairs, Purchases, Refinery, Accounts, HR & Incentives, Approvals, Reports (read-only views), Notifications (outbox), SaaS Billing. **Only Sales writes invoices, only Inventory mutates stock, Reports never writes.** |
| D1–D2 (from spec) | Owner owns the code; rebrand. Hidden backup billing dropped; invoice-integrity rules INV-1..INV-6 are mandatory and enforced in the database. |

### 1.1 Decisions update v0.3 (master bot, 20 Oct 2026)

| # | Decision | Where applied |
|---|---|---|
| D13 | **Scope is retail only.** Manufacturing (karigar job cards, job issue/receipt) is deferred; a future `manufacturing` module plugs in additively (new schema, FKs only to existing tables). Customer orders and repairs (optionally outsourced to a vendor) and refinery stay. | §4, §4.1 |
| D14 | **Plain self-managed PostgreSQL 17** (minimum 16). Only the contrib extension `btree_gist`; no vendor-specific features (Supabase/Neon), no `pg_cron`. | §3, §5.1 |
| D15 | **Data model v0.2 (`/workspace/jewellery-data-model`) is authoritative.** Invoice and stock writes happen **in the app** through per-module writer roles (`sales_writer`, `inventory_writer`, `accounts_writer`; NOLOGIN, `app_rw` is a member WITH INHERIT FALSE, SET TRUE, used via `SET LOCAL ROLE` inside the request transaction). `sales.issue_invoice()` SECURITY DEFINER is removed. The DB keeps: the locked gapless counter, immutable bills, the hash-chained audit log, forced RLS, the credit-note → outbox trigger (the only alert writer; unique key `credit_note_id + alert_type`, implemented by D33's outbox columns) and a DDL guard. | §4.1, §5.1, §11 |
| D16 | **Migrations:** the SQL files are the source of truth, applied by the API's `migrate.js` with checksums (an edited, already-applied file fails the run). `000_bootstrap.sql` runs once as superuser (roles, schemas, extension, DDL guard); everything else runs as `app_migrator`. **Drizzle is used for types only** (generated from the DB), not for migrations. | §3, §4, §5.1 |
| D17 | **Accounts exposes a function that Sales calls inside the invoice transaction** (ledger postings commit or roll back with the invoice). | §4.1 |
| D18 | **Money `numeric(14,2)`, weights `numeric(12,3)`**, sent on the wire (OpenAPI/JSON) as **decimal strings**, never JSON numbers. | §3, §8 |
| D19 | *(Refined by D34.)* **Rounding:** line amounts to 0.01 half-up; each tax component (CGST, SGST, IGST, cess) computed and rounded separately; invoice total rounded to ₹1 by default (configurable), shown as a round-off line. | §8 |
| D20 | **Auth:** server-side Postgres sessions in httpOnly cookies; password with **optional OTP**; counter device registration. | §3, §10 |
| D21 | *(Superseded by D29: there is no offline billing.)* **Offline bills** get a **provisional receipt**; the gapless number is assigned at sync. `doc_date` is the sale date (at most 5 min in the future); back-dating beyond 72 h needs a permission. Reports and GSTR-1 group by `doc_date`. | §3.2, §8, §11 |
| D22 | A **client-supplied invoice number is rejected.** HUID is 6 alphanumeric characters, normalised to uppercase. | §8, §11 |
| D23 | **Only tax invoices and credit notes are gapless** (other documents use ordinary non-gapless references). | §11 |
| D24 | **Cancelling across financial years** means a credit note in the **current** FY; the old invoice is never changed beyond `issued → cancelled`. | §11 |
| D25 | *(Made configurable by D36.)* **Alerts on every cancellation plus a daily summary.** | §11, §15 |
| D26 | **PAN threshold configurable, default ₹2 lakh.** Errors go to the **Sentry free tier**. | §8, §12 |
| D27 | **Dev environment:** the owner's own Ubuntu server (2 vCPU, 8 GB), run with Docker Compose; CI is GitHub Actions with a **self-hosted runner** on that server. | §13 |
| D28 | **Bot team:** master, data, backend, frontend, QA, DevOps. | §14 |

### 1.2 Decisions update v0.4 (owner overrides and accepted decisions, 20 Oct 2026)

| # | Decision | Where applied |
|---|---|---|
| D29 | **No offline billing at all (overrides D21).** Billing is blocked when the internet or the API server is unreachable: no provisional receipts, no offline queue, no numbering at sync. **`doc_date` is the server date in IST** (`Asia/Kolkata`), never client-supplied. Offline/PWA support is limited to **read-only cached screens**. | §3, §3.2, §7, §8, §11, §13 |
| D30 | **Language is a master setting:** a tenant default plus a per-user override. Invoices and prints can optionally use **any chosen language per print**, including the amount in words and **native numerals**. | §3, §3.1, §3.3, §9, §20.5 |
| D31 | **GST rates are managed in Settings** (effective-dated `masters.tax_rule` and `gst_config` rows; no hard-coded rates). | §4.1, §9 |
| D32 | **Guided onboarding wizard:** a resumable 10-step stepper. "Start billing" is enabled only after steps 1, 2, 4, 5 and 6; a checklist card stays on the dashboard until setup is complete. | §4.1, §21 |
| D33 | **Outbox columns `ref_type`, `ref_id`, `alert_type`** with a **partial unique index** (one alert per referenced document and alert type). | §11, §15 |
| D34 | **Per-line tax rounding:** tax is computed per invoice line, and each component (CGST, SGST, IGST, cess) is rounded separately to 0.01 half-up. | §8 |
| D35 | **An invoice's only allowed change is the guarded status transition `issued → cancelled`.** | §11 |
| D36 | **INV-5 thresholds are configurable.** Defaults: alert on every cancellation; escalate when there are **more than 5 per branch per day**; **no daily summary on zero days**. | §11, §15 |
| D37 | **The API writes outbox rows** (in the business transaction); the **worker (`app_worker`) enqueues them to pg-boss**, which lives in its own **`pgboss` schema**. | §3, §4.1, §5.1, §7.2, §15 |

## 2. Architecture at a glance

**Shape:** a **modular monolith** of **14 functional NestJS modules** (decision D12; Section 4.1) in TypeScript (one API process plus one worker process, which can be the same process on small installs), PostgreSQL as the only stateful dependency, and a static PWA frontend. No Redis, Kafka, Elasticsearch or Kubernetes in the core. Every extra stateful service multiplies cost and on-prem support load.

```
+---------------- Control plane (you host; 1 small VM) -----------------+
| signup | plans/subscriptions | licences | update manifests            |
| tenant registry | backup heartbeat | audit-hash anchoring             |
+-----------------------------------------------------------------------+
        ^ HTTPS, outbound only, from every deployment below ^

+--- Shared cloud ----------+  +--- Dedicated ------+  +--- On-prem (shop LAN) ---+
| Caddy -> api xN           |  | same compose file  |  | mini-PC / server:        |
|   -> PgBouncer -> Postgres|  | 1 tenant, own VM   |  |  Caddy, api+worker, PG   |
| worker xN (pg-boss)       |  | and own database   |  |  updater, local backups  |
| many tenants, RLS         |  |                    |  | counter PCs: PWA browser |
+---------------------------+  +--------------------+  |  + print-agent (USB/COM) |
  S3-compatible object storage (backups, images, PDFs)  +--------------------------+
```

The same Docker images run in all three modes. Only configuration differs (Section 9). Branding is runtime data too (Section 20), so a white-labelled deployment uses the same images.

**Diagram:** `jewellery_saas_architecture.png` / `.svg` (Graphviz source `arch.dot`) shows the devices, proxy (custom domains and on-demand TLS), the 14 API modules (with the Branding service inside Platform), data, external services, operations and the deployment modes.

![System architecture](/workspace/jewellery_saas_architecture.png)

## 3. Recommended stack

| Layer | Recommendation | Rationale | Alternatives considered |
|---|---|---|---|
| Language | **TypeScript (strict)** end-to-end, Node.js **Active LTS** | One language for agents and humans; shared types; D3 | — |
| Monorepo tooling | **pnpm workspaces + Turborepo** | Fast, cached tasks; simple for agents | Nx (heavier, more magic) |
| API framework | **NestJS on the Fastify adapter** | Opinionated modules, DI, guards and interceptors give agents strong, repeatable conventions; Fastify performance | Plain **Fastify + TypeBox/Zod** (lighter and faster, fewer conventions); Hono |
| API contract | **OpenAPI 3.1 as source of truth** (contract-first), linted by Spectral | Typed contract between agent-written frontend and backend; code generation; breaking-change detection | tRPC/ts-rest (great DX but weaker for third-party/mobile clients and on-prem version skew) |
| Validation / codegen | **Zod** schemas + types + **TanStack Query hooks generated from OpenAPI** (e.g., Orval) | Runtime validation at every boundary; no hand-written fetch code | openapi-typescript + openapi-fetch |
| ORM / SQL | **Hand-written SQL migrations are the source of truth** (D16), applied by the API's `migrate.js` with checksums; **Drizzle for types only** (schema generated from the DB with `drizzle-kit pull`; Drizzle never generates migrations) | Close to SQL; first-class Postgres; RLS, triggers and grants stay in versioned SQL | Prisma (great DX, but RLS, triggers and `SET LOCAL` per transaction are awkward); Kysely |
| Database | **Plain self-managed PostgreSQL 17** (minimum 16; D14) with only the contrib extension `btree_gist`; `gen_random_uuid()` and `sha256()` are built-ins | D4; RLS; transactional DDL; NUMERIC for money/weight; runs identically on-prem and in any cloud | — |
| Jobs / queue | **pg-boss** (queue in Postgres, own `pgboss` schema) fed by a **transactional outbox**: the API writes outbox rows, the worker (`app_worker`) enqueues them to pg-boss (D37) | No Redis; the business transaction never touches the queue | BullMQ + Valkey (only if throughput demands it) |
| Connection pooling (shared cloud) | **PgBouncer** (transaction mode) | Many tenants, few connections; `SET LOCAL` works per transaction | Pgpool-II |
| Object storage | **S3 API only** (MinIO / Garage self-hosted, or any S3-compatible provider) | Cloud-agnostic; same code on-prem | Filesystem adapter for the smallest on-prem installs |
| Reverse proxy / TLS | **Caddy** | Automatic HTTPS, tiny config, works on-prem | Traefik, Nginx |
| Frontend | **Vite + React + TypeScript SPA/PWA**, **TanStack Router + TanStack Query + TanStack Table**, **React Hook Form + Zod**, **shadcn/ui (Radix) + Tailwind CSS** | Back-office app with no SEO need. A static build can be served by the API on-prem, works offline as a PWA, and avoids SSR servers | **Next.js** (SSR/RSC adds a Node runtime per deployment and complicates offline/on-prem; not needed); Remix/React Router v7 |
| Design system | **Design-token system from day one** (D11): colour, typography, radius, spacing and density tokens exposed as **CSS variables** and consumed by Tailwind and shadcn/ui; "counter mode" (large touch targets, keyboard-first) and "office mode" (dense tables); zero hard-coded brand names or colours (Section 20.4) | D5: fresh, non-AuSales look; D11: every tenant/partner can re-skin without code | MUI/Ant (heavier, generic look) |
| Offline client store | **Dexie (IndexedDB)** + **Workbox** (vite-plugin-pwa) | Cache app shell and **read-only** screens (masters, rates, stock snapshot, recent documents); no offline writes (D29) | RxDB, PowerSync/ElectricSQL (powerful sync engines, but extra infra; revisit for branch sync) |
| Money / weight maths | **`decimal.js`** in a pure `domain` package; Postgres `numeric(14,2)` money and `numeric(12,3)` weights; **decimal strings on the wire** (D18) | Never floats (the legacy app used `parseFloat`) | Integer paise / milligrams (also fine; NUMERIC chosen for readability) |
| PDF generation | **HTML/CSS templates → headless Chromium (Gotenberg container)** for A4/A5 PDFs | Correct shaping for Tamil/Devanagari; one template language for screen and PDF | `@react-pdf/renderer` / pdfmake (lighter, but complex-script shaping for Indic text is unreliable; test before adopting) |
| Thermal / label printing | **Local print-agent** (TypeScript, packaged as a single executable) speaking **ESC/POS** (receipts) and **TSPL/ZPL/EPL** (tag labels) | Raw printing from browsers is unreliable | QZ Tray (open source, mature; paid support); WebUSB/Web Serial (Chrome-only, fiddly drivers) |
| Auth | In-house, using vetted libraries (D20): **server-side Postgres sessions in httpOnly cookies**, **argon2id** passwords with **optional OTP** (SMS/WhatsApp), **counter device registration** | No external IdP dependency on-prem; simple | Keycloak/Authentik (heavy for on-prem); Better Auth (evaluate) |
| i18n | **FormatJS / react-intl** (or i18next) with ICU messages; `Intl.NumberFormat('en-IN')` and numbering systems (`latn`, `tamldec`, `deva`, …) for native numerals; language from tenant default → user override, per-print override (D30) | Lakh/crore grouping, ₹, plurals, native numerals | — |
| Testing | **Vitest**, **Testcontainers (Postgres)**, **Playwright**, **Schemathesis** (contract fuzzing), **Stryker** (mutation testing on `domain`) | High coverage that agents can run locally and in CI | Jest |
| Lint / format | **ESLint (typescript-eslint strict) + Prettier**, or **Biome**; **dependency-cruiser** for module boundaries | Mechanical conventions that agents cannot drift from | — |
| Observability | **pino** JSON logs + **OpenTelemetry** → self-hosted **VictoriaMetrics + VictoriaLogs + Grafana**, **Sentry free tier** for errors (D26), **Uptime Kuma** | Vendor-neutral and cheap (one small VM) | GlitchTip (self-hosted, Sentry-compatible) if the free tier is outgrown; Grafana Cloud free tier |
| CI/CD | **GitHub Actions with a self-hosted runner** on the owner's dev server (D27), images in GHCR or self-hosted Zot/Harbor, **cosign** signing | Common, agent-friendly; registry is swappable | GitLab CI |
| Infra as code | **OpenTofu** + **Ansible**, **Docker Compose** per mode | Provider-agnostic; Compose is enough at this scale | Kubernetes (only if the shared cloud exceeds a few VMs) |

### 3.1 Indian locale and formatting (requirements)
- Currency: `₹1,23,45,678.50` via `Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })`. Lakh/crore grouping everywhere, including Excel exports (written with an Indian-grouping custom number format, tested in Excel and LibreOffice).
- Amount in words, Indian style ("Rupees One Lakh Twenty-Three Thousand … Only"), from a tested `domain` function **for every supported language** (English, Tamil and Hindi first), because any print can use any chosen language (D30).
- **Native numerals** (e.g. Tamil ௧௨௩, Devanagari १२३) are an optional per-print setting, alongside the print language. The stored values and the GST fields used for returns stay in Western digits.
- Weights: grams to 3 decimals (`12.345 g`); purity as karat and fineness (`22K 916`); dates `dd-MM-yyyy`; timezone Asia/Kolkata; financial year April–March (drives INV-1 series).
- Fonts: Noto Sans plus Noto Sans Tamil and Noto Sans Devanagari, bundled locally (no CDN on-prem).
- Languages: English and Tamil first, then Hindi, Telugu, Kannada and Malayalam (with the matching Noto fonts bundled). **Language is a master setting** (D30): a tenant default plus a per-user override for the UI; prints default to the tenant/branch print language and can be changed per print. All UI strings come from message catalogues (CI fails on hard-coded strings).
- GSTIN, PAN, IFSC, PIN code and Indian mobile validators live in `domain`. State codes follow GST state codes (for place of supply and IGST vs CGST/SGST).

### 3.2 PWA and offline needs (D29: no offline billing)
- **Billing needs a live API server.** When the server is unreachable (cloud modes: no internet; on-prem: LAN server down), billing is **blocked**: the bill and checkout actions are disabled and a clear "offline: billing unavailable" banner is shown. There are **no provisional receipts, no offline queue and no numbering at sync**.
- **On-prem mode** is still the answer for poor-internet shops: the API server is on the shop LAN, so the counter reaches it without the internet. The internet is needed only for licence check-in, updates, offsite backup, notifications, GST/e-invoice APIs and rate feeds, which go through the outbox (Section 7). *(Interpretation to confirm with the owner: D29 blocks billing when the counter cannot reach the API server; for on-prem that is the LAN server.)*
- **Cloud modes:** the PWA caches the app shell and **read-only screens** (masters, today's rates, a stock snapshot, recent documents) in IndexedDB, so staff can look up tags and prices during an outage. Nothing can be created, edited or printed as a document while offline.
- **`doc_date` is the server date in IST** (`Asia/Kolkata`) at the moment of issue, never a client value. It drives the FY series, reports and GSTR-1. Shops with chronically bad internet should use on-prem or a hybrid "edge" node (Section 7.3).
- HTTPS is required for service workers. Cloud: normal certificates. On-prem: each install gets a hostname such as `shop-1234.lan.<brand>.in` resolving to the box's LAN IP, with a Let's Encrypt certificate obtained by DNS-01 through the control plane, so counters get a trusted HTTPS origin with no self-signed warnings.

### 3.3 Printing approach
| Output | Approach |
|---|---|
| A4/A5 tax invoice, estimate, order/repair receipt, purchase voucher, credit note | **Versioned** per-tenant HTML/CSS templates (Section 20.5), rendered in the **print language and numeral system chosen for that print** (D30) (Handlebars-style, with a sandboxed variable whitelist). **Browser print** at the counter (zero server cost); **Gotenberg (headless Chromium)** for PDFs to WhatsApp/email and archive. The PDF hash is stored with the invoice. Reprints are stamped "DUPLICATE/REPRINT" and audited. |
| 80 mm / 58 mm thermal receipts | Print-agent sends **ESC/POS** directly (fast, no dialog). Fallback: browser print with an 80 mm CSS page size. |
| Jewellery tag labels (barbell/"dumbbell" tags, small labels) | Print-agent sends **TSPL / ZPL / EPL** to common label printers (TSC, Zebra, Godex, Argox; confirm models with pilots). Code 128 / QR (tag no., HUID, weight, purity). Label layout designer with per-printer calibration (offsets, darkness). |
| Barcode / QR scanning | USB keyboard-wedge scanners need no integration. Camera scanning in the PWA on tablets/phones. |
| Weighing scale | Print-agent reads RS-232/USB serial scales and pushes the weight to the open tag/bill form. This is an IoT-style integration that suits the owner's background. |

The print-agent is a small signed tray app for Windows (and Linux). It listens only on `localhost`, is paired with the user's session by a one-time code, accepts jobs only from the tenant's origin, and auto-updates through the same channel as the server.

## 4. Repository structure (monorepo)

```
/                         pnpm + Turborepo monorepo
|-- AGENTS.md              global rules for coding agents (see Section 14)
|-- apps/
|  |-- api/                NestJS (Fastify) modular monolith (D12)
|  |  `-- src/modules/          14 functional modules (Section 4.1)
|  |     |-- platform/          tenants, partners, identity, org, roles, settings, flags,
|  |     |                      audit, licences, branding/, domains/, print-templates/
|  |     |-- masters/           metals, purities, tax/HSN, items, standards, parties
|  |     |-- rates/             daily / old-metal / carat rates, rate publishing
|  |     |-- inventory/         lots, tags, HUID, stock ledger (only stock writer)
|  |     |-- sales/             estimates, invoices, credit notes (only invoice writer)
|  |     |-- orders-repairs/    customer orders, repairs (optionally outsourced to a vendor);
|  |     |                      manufacturing/karigar jobs deferred (D13)
|  |     |-- purchases/         purchases, old-metal buying, vendor settlement
|  |     |-- refinery/          bags, melting, purification
|  |     |-- accounts/          ledgers, vouchers, advances, suspense; exports the posting
|  |     |                      function Sales calls inside the invoice transaction (D17)
|  |     |-- hr-incentives/     staff, incentive slabs, targets
|  |     |-- approvals/         approval types, rules, requests
|  |     |-- reports/           read-only views (never writes)
|  |     |-- notifications/     outbox, templates, per-tenant senders
|  |     `-- saas-billing/      plans, subscriptions, partner and white-label fees
|  |        each module: <name>.module.ts, public/ (facade service + DTOs),
|  |        internal/ (controllers, use-cases, repositories), db/ (Drizzle types
|  |        for its own Postgres schema, generated; types only), events/, tests/
|  |-- migrate.js          applies db/migrations/*.sql in order, records checksums (D16)
|  |-- worker/             pg-boss consumers (notifications, PDFs, e-invoice, backups, reports)
|  |-- web/                Vite React PWA (counter mode + office mode)
|  |-- control-plane/      thin entrypoint composing Platform + SaaS Billing in control-plane role
|  |                      (signup, partner/tenant registry, licences, update manifests)
|  |-- updater/            on-prem update/rollback agent
|  `-- print-agent/        local ESC/POS + TSPL/ZPL + scale bridge
|-- packages/
|  |-- contracts/          OpenAPI 3.1 (YAML, split per module) → generated types, Zod, client hooks
|  |-- domain/             pure TS: pricing (MC/wastage/stone/HUID), GST, weights, purity, amount-in-words
|  |-- db/                 migrations/*.sql = source of truth (from jewellery-data-model v0.2:
|  |                      000_bootstrap superuser-once ... 900_security), guardrail tests, seeds;
|  |                      generated Drizzle types; per-module type files live in each module
|  |-- ui/                 design system (shadcn-based components, icons); no brand values
|  |-- design-tokens/      token schema (Zod), defaults, CSS-variable generator, contrast checker
|  |-- i18n/               message catalogues (en, ta, hi …) + Indian formatters
|  |-- config/             Zod config schema, feature-flag registry, plan entitlements
|  |-- print-templates/    platform-default templates (invoice, estimate, credit note, receipt,
|  |                      tag label), template linter (mandatory GST fields), renderers
|  |-- notification-providers/ provider interface + adapters (SMS, WhatsApp, email, push)
|  |-- test-utils/         factories, golden bills, Testcontainers helpers, sample brands
|  |-- brand-packs/        sample/partner brand packs for dedicated & on-prem (Section 20.7)
|  `-- tooling/            eslint, tsconfig, generators (module/endpoint/migration scaffolds)
|-- infra/
|  |-- compose/            onprem.yml · dedicated.yml · shared.yml (+ overrides)
|  |-- tofu/               provider modules (generic VM + S3 bucket + DNS)
|  `-- ansible/            host hardening, Postgres, backups, observability
`-- docs/
   |-- adr/                architecture decision records
   |-- specs/              feature specs (traceable to product spec IDs)
   `-- runbooks/           restore, upgrade, incident, on-prem install
```

### 4.1 Functional modules and ownership (decision D12)

Each module is a NestJS module that **owns its own Postgres schema** (tables, views, functions) and its own routes (`/api/v1/<module>/…`). Other modules may use only its **exported facade service** (`public/`) or subscribe to its **domain events**. They never import its repositories or query its tables.

| # | Module | Owns (tables / routes) | Key exported services / events | Ownership rules |
|---|---|---|---|---|
| 1 | **Platform** | Partners, tenants, companies/branches/floors/counters/boxes, users, roles and permissions, sessions, settings (incl. tenant default language and user language override, D30), **onboarding wizard state** (D32), feature flags, **audit log**, licences, document-series registry, **Branding service** (branding profiles, design tokens, assets), **custom domains**, print-template registry | `TenantContext`, `AuthZ.check()`, `Branding.resolve(host)`, `Domains.verify()`, `Templates.resolve(kind)`, `Audit.record()` | The only writer of identity, tenancy, branding and audit data; the audit log is append-only (INV-3) |
| 2 | **Masters** | Metals, purities, **GST rates/HSN managed in Settings** (`tax_rule`, `gst_config`, effective-dated; D31), items/sub-items, stone/diamond standards, value-addition rules, customers, vendors/account-head profiles, repair types | `Masters.getItem()`, `Parties.findCustomer()` | Snapshotted into documents by consumers; never edited retroactively |
| 3 | **Rates** | Daily metal rates (effective-dated, per branch/purity), old-metal rates, carat rates, rate feed and publish approvals | `Rates.current()`, `Rates.at(timestamp)`; event `RatePublished` | Only Rates writes rates; consumers store the rate snapshot they used |
| 4 | **Inventory** | Lots, tags (HUID, weights, stones), stock ledger, stock statuses, transfers, goods-on-approval movements, old-metal and bullion stock, stock-takes, box weight checks | `Stock.reserve()`, `Stock.markSold()`, `Stock.receive()`, `Stock.transfer()`, `Stock.returnToStock()`; events `StockMoved` | **Only Inventory mutates stock.** Every stock change is a ledger entry written by Inventory's service as `inventory_writer` (`SET LOCAL ROLE`; column grants on `tag.status/branch_id`); other modules request movements through its service |
| 5 | **Sales** | Estimates, **tax invoices**, credit notes, sales returns, old-gold exchange lines, bill payments, invoice series (INV-1) | `Sales.issueInvoice()`, `Sales.cancelInvoice()`; events `InvoiceIssued`, `InvoiceCancelled` | **Only Sales writes invoices** (and credit notes). `SalesService.issueInvoice()` / `cancelInvoice()` run one transaction: switch to `sales_writer` to allocate the number and insert the documents, call Accounts' posting function, then switch to `inventory_writer` for the stock step (INV-1, -2, -4; data model v0.2) |
| 6 | **Orders & Repairs** | Customer/shop orders (optionally outsourced to a supplier), attachments, repair jobs, vendor issue/receipt, delivery notes. Manufacturing/karigar job work is deferred (D13) | `Orders.receiveFinished()`; events `OrderReady`, `RepairReady` | Finished goods enter stock via Inventory; billing via Sales; advances via Accounts |
| 7 | **Purchases** | Purchase orders/entries, old-metal purchases from customers, vendor settlement documents (rate-cut, metal/cash), vendor discounts | `Purchases.post()`; events `PurchasePosted`, `VendorSettled` | Stock in via Inventory; ledger postings via Accounts; own (non-sales) voucher series |
| 8 | **Refinery** | Bags/transfer creation, melting issue/receipt, purification issue/receipt, loss records | events `MeltReceived`, `PurificationReceived` | Metal movements via Inventory; charges via Accounts |
| 9 | **Accounts** | Chart of accounts, vouchers, party ledgers (₹ and grams), advances, suspense, customer credit/debit, GST return data | `Ledger.post()`, `Advances.apply()`, **`Accounts.postInvoice(tx, …)`** called by Sales inside the invoice transaction (D17) | Only Accounts writes ledger entries (as `accounts_writer`); it reacts to other modules' events for asynchronous postings |
| 10 | **HR & Incentives** | Staff, incentive slabs, counter/staff targets, incentive calculations | `Incentives.forPeriod()` | Reads sales via events or Reports views; never writes invoices |
| 11 | **Approvals** | Approval types, rules, requests, decisions | `Approvals.request()`; events `ApprovalGranted/Denied` | Never mutates another module's data; the owning module applies the outcome when it receives the event |
| 12 | **Reports** | Read-only SQL views / materialised views over other modules' **published reporting views**, export jobs | `Reports.run()` | **Never writes business data.** Connects as `app_ro` (SELECT only) or to a read replica. View refresh runs as a job owned by the source module |
| 13 | **Notifications** | **Outbox**, message templates, **per-tenant sender configs** (WhatsApp, SMS/DLT, email), delivery logs, opt-outs | `Notify.enqueue()` (joins the caller's transaction) | The only module that calls external messaging providers. Cancellation/return alerts are written **only** by the DB credit-note trigger (D15) |
| 14 | **SaaS Billing** | Plans, subscriptions, entitlements, partner wholesale pricing and **white-label fees**, platform payment-gateway integration, the platform's own subscription invoices | `Entitlements.check()`; events `SubscriptionChanged` | Platform-operator invoices are a separate legal entity's documents (own gapless series), never tenant tax invoices |

**How the rules are enforced:**
- **Code:** dependency-cruiser and ESLint import rules allow imports only from `modules/<x>/public`. Each module's Drizzle schema can be imported only by that module. CI fails on violations.
- **Database:** one Postgres schema per module. Writes to `sales.invoice*` and credit notes need the NOLOGIN role `sales_writer`, writes to `inventory.stock_ledger` / tag status need `inventory_writer`, and ledger entries need `accounts_writer`. `app_rw` is a member of each **WITH INHERIT FALSE, SET TRUE**, so it has none of their rights until the owning module's unit of work runs `SET LOCAL ROLE …` inside the request transaction. Code in any other module runs as plain `app_rw` and cannot write invoices or stock. Reports uses the SELECT-only `app_ro` role (views are `security_invoker`). A CI check fails if `SET LOCAL ROLE <x>_writer` appears outside the owning module. This does not protect against a fully compromised API process; the immutability triggers and audit chain cover that (Section 11).
- **Transactions:** a use case is opened by the owning module. Other modules' service calls join it through an AsyncLocalStorage transaction context. For example, `Sales.issueInvoice()` calls `Accounts.postInvoice()`, `Stock.markSold()` and `Notify.enqueue()` in the same transaction, so either everything commits or nothing does.
- **Asynchronous reactions** (ledger postings, incentives, e-bills, cache invalidation) go through domain events in the outbox: the API writes outbox rows in the business transaction, the worker (`app_worker`) enqueues them to pg-boss (`pgboss` schema), and handlers are idempotent (D37).
- **Agent tasks are scoped to one module.** A change spanning modules is split into a contract change on the providing module's facade first, then consumer changes.

## 5. Tenancy design across the three modes

### 5.1 One schema, one code path
- Every tenant-owned table has `tenant_id uuid NOT NULL` as the **first column of every primary key and index** (e.g., `PRIMARY KEY (tenant_id, id)`). IDs are **UUIDv7** (time-ordered, globally unique), so data can move between modes (cloud → dedicated → on-prem) without ID collisions.
- **RLS is enabled and forced in every mode**, even on-prem with one tenant. There is one code path and one set of tests, and accidental cross-tenant reads are impossible.

```sql
ALTER TABLE invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
```

- The API connects as `app_rw`: no `BYPASSRLS`, not the table owner, and no DELETE/TRUNCATE on protected tables (Section 11). Each request runs in a transaction that starts with `SELECT set_config('app.tenant_id', $1, true)` (transaction-local, safe with PgBouncer transaction pooling), plus `app.user_id` and `app.branch_id` for audit triggers.
- Migrations run as a separate `app_migrator` role (owns all objects; not a superuser, no BYPASSRLS), applied by the API's `migrate.js` with checksums. `000_bootstrap.sql` runs **once as superuser** to create roles, schemas, `btree_gist` and the DDL guard (D16). Reporting/read replicas use `app_ro`; the worker uses `app_worker`, which reads pending outbox rows, enqueues them to pg-boss in the `pgboss` schema and marks them relayed (D37).
- **Branch scoping** is a second layer: permission guards in the API, and optional RLS on `branch_id` for branch-restricted roles.

### 5.2 Mode-specific behaviour
| Aspect | Shared multi-tenant cloud | Dedicated cloud | On-prem |
|---|---|---|---|
| Tenants per DB | Many (start with one cluster; shard by moving tenants to more clusters later) | One | One |
| `tenant_id` source | Resolved from session (subdomain `shop.<brand>.in` → tenant) | Fixed in config (`TENANT_ID`) | Fixed in licence file |
| Signup | Self-serve via control plane | Provisioned by you (OpenTofu + Ansible) | Installer + licence activation |
| Subscription enforcement | Live entitlement check (cached) | Same | Signed licence file (Section 6) |
| Data location | Your cloud (India region recommended) | Customer-chosen provider/region | Shop premises (+ encrypted offsite backup) |
| Updates | Rolling, you control | Wave-based, maintenance window agreed | Channel-based, staged, auto-rollback |

### 5.3 Noisy neighbours and scaling (shared cloud)
Per-tenant rate limits and statement timeouts; heavy reports run on a read replica or as async jobs; `tenant_id`-leading indexes. When one cluster saturates, move the biggest tenants to their own cluster (the tenant registry in the control plane records which cluster serves each tenant), or upsell them to dedicated.

### 5.4 Tenant portability
A signed, encrypted **tenant bundle** (logical export filtered by `tenant_id`, plus object-storage files and audit hash chain) supports migration between modes, customer exit and regulatory requests. Import verifies the audit chain before accepting.

### 5.5 Partner (reseller) level
A partner level sits above tenants (`platform.partner`; `tenant.partner_id`). Partner users are scoped by `app.partner_id` to registry and billing data only. See Section 20.1.

## 6. Licensing, activation and updates (on-prem and dedicated)

### 6.1 Licence model
- A **licence file** is a JSON document signed with **Ed25519** by the control plane. It contains tenant ID, legal name, GSTIN(s), plan, enabled modules, limits (branches, users, counters), validity dates, update-entitlement end date, a soft hardware binding (hash of machine ID and DB system identifier), and an offline grace period.
- The app verifies the signature offline with an embedded public key. There is no phone-home requirement to run.
- **Activation:** online (installer contacts the control plane) or **offline** (installer shows a request code; support returns the licence by WhatsApp/email; customer pastes or uploads it).
- **Check-in:** when internet is available, at most daily, the box renews its licence lease and reports its version, backup status and audit-chain head hash.
- **Expiry policy (recommendation; owner to confirm):** 30 days of warning banners, then a 30-day grace, then **read-only mode**. Viewing, reports, exports, reprints and credit-note cancellation still work. New sales stop. **Data is never locked or held hostage.**
- Anti-piracy is pragmatic (signature, soft binding, check-in anomalies, legal terms), not DRM. Owners of on-prem boxes have physical access.

### 6.2 Update and upgrade channel
- **Channels:** `stable`, `beta` (pilot shops), and `lts` (security fixes only, for conservative customers). The control plane publishes a **signed release manifest** (version, image digests, minimum source version, migration notes, rollout percentage).
- Images are **multi-arch** (amd64 and arm64), signed with **cosign**, and pulled by digest.
- **On-prem updater:** checks the manifest, downloads in the background, schedules for after closing time (configurable), takes a **pre-upgrade backup**, stops the API, runs migrations, health-checks, and **auto-rolls back** (previous images plus restore) on failure. It reports the result to the control plane.
- **Offline update:** a signed USB/download bundle (`docker save` tarball plus manifest) for shops without usable internet.
- **Migrations:** forward-only, expand/contract pattern, so the old API version runs on the new schema during rollouts. Every migration is tested against anonymised snapshots of real tenant data in CI.
- **Version skew:** the PWA checks the API version and reloads. The print-agent and updater are backward compatible across two minor versions.

## 7. Backups, sync and offline strategy

### 7.1 Backups (all modes)
| Mode | Method | Targets (recommendation) |
|---|---|---|
| Shared cloud | **pgBackRest** (or WAL-G): weekly full, daily differential, continuous WAL archiving to S3-compatible storage in a **different provider/region**; encrypted (AES-256) | RPO ≤ 5 min, RTO ≤ 2 h; keep 35 days of PITR and 12 monthly copies; monthly automated restore test |
| Shared cloud, per tenant | Nightly per-tenant logical export (tenant bundle) for self-service download and portability | Keep 7 nightly + 4 weekly |
| Dedicated | Same as shared, per instance | Same |
| On-prem | (1) pgBackRest to a **second local disk/USB drive**, hourly WAL; (2) **client-side-encrypted offsite copy** to your object storage when online; (3) one-click restore tool; (4) the control plane alerts the owner (WhatsApp/SMS/email) if no successful offsite backup for 48 h | RPO ≤ 1 h (local), ≤ 24 h (offsite); RTO ≤ 4 h on replacement hardware |

Encryption keys for on-prem offsite backups: generated on the box, with optional escrow to the control plane (recommended, with owner consent) so you can restore after a disk failure. Backup integrity: checksums plus automated test restores in the cloud, and verification of the audit hash chain after restore.

### 7.2 On-prem offline operation
- The on-prem server is the **system of record**. Everything a shop does in a day works with no internet.
- Internet-dependent actions use a **transactional outbox** (rows written by the API in the same transaction as the business event; the worker enqueues them to pg-boss and they are delivered when online, D37): notifications, e-invoice IRN requests, GSTIN lookups, offsite backup, licence check-in, audit-hash anchoring, telemetry.
- E-invoice (for tenants above the threshold): IRN requests are queued with **deadline alerts**, because IRP reporting has time limits for larger taxpayers. Confirm with the CA.

### 7.3 Multi-branch and sync
- **Recommendation for multi-branch customers: cloud (shared or dedicated).** Branches with poor internet cannot bill while offline (D29); they get read-only cached screens, or should use on-prem / an edge node.
- **On-prem multi-branch, option 1 (MVP-friendly):** one HQ server; branches connect over a **WireGuard mesh (Tailscale, or self-hosted Headscale)**.
- **Option 2 (later, Phase 3+): per-branch edge nodes with sync.** Each branch server owns its **own** invoice series (INV-1 is per branch, so no cross-branch number coordination is needed) and its own stock. Masters flow HQ → branches. Transactions flow branches → HQ as an append-only, idempotent event log over HTTPS (UUIDv7 IDs, per-row origin and version). Conflicts are avoided by ownership rules rather than merged: masters are owned by HQ, transactions by the branch that issued them, and stock transfers are a two-phase handshake.
- **Cloud mirror (optional add-on):** one-way replication from an on-prem box to a read-only cloud copy for the owner's mobile dashboard and offsite reporting.

## 8. Data model notes relevant to the domain
- Monetary: `NUMERIC(14,2)`. Weight (g): `NUMERIC(12,3)`. Purity/fineness: `NUMERIC(6,3)`. Rates per gram: `NUMERIC(12,2)`. Money and weights travel in the API as **decimal strings** (e.g. `"12345.50"`, `"9.875"`), never JSON numbers (D18).
- **Rounding (D19, D34):** all rounding happens in one `domain` function. Line amounts round to 0.01 half-up; **tax is computed per line**, and each tax component (CGST, SGST, IGST, cess) is rounded separately on that line; invoice tax totals are the sums of the rounded line components; the invoice total rounds to ₹1 by default (configurable in `gst_config`), shown as a round-off line.
- **Dates (D29):** `doc_date` is the **server date in IST** at issue (no client value, no back-dating) and drives the FY series, reports and GSTR-1; `issued_at` is the server timestamp of numbering.
- **Statutory checks:** PAN required at or above a configurable threshold (default ₹2 lakh, D26); s.269ST cash limit.
- Rates are **effective-dated** (`metal_rate(tenant_id, branch_id, metal_id, purity_id, effective_from)`). An invoice line **snapshots** the rate, MC/wastage parameters, tax rate, HSN and HUID used, so later master changes never alter issued documents.
- Tags: one row per physical piece, with HUID (6 alphanumeric characters, normalised to uppercase, unique per tenant; D22), weights, stones/diamonds as child rows, and a status machine (in-stock → on-approval → sold → returned …) recorded in an append-only stock ledger.

## 9. Configuration and feature flags per deployment

**Layered configuration (lowest to highest precedence):**
1. **Code defaults** in `packages/config` (Zod schema; the app refuses to boot on invalid config).
2. **Deployment config:** environment variables or `/etc/<brand>/config.yaml`, e.g. `DEPLOYMENT_MODE=shared|dedicated|onprem`, DB URL, S3 endpoint, SMTP, notification provider keys, backup targets, `TENANT_ID` (single-tenant modes).
3. **Entitlements:** from the subscription (cloud) or licence file (on-prem/dedicated): modules, limits, plan.
4. **Partner settings** (DB): partner branding defaults, default templates and senders, allowed plans (Section 20).
5. **Tenant settings** (DB, admin UI): GSTINs, state, **GST rates** (effective-dated, D31), branding, print templates, rounding, return-policy days, **default language and print language/numerals** (D30), INV-5 alert thresholds (D36), notification templates and senders. **User settings:** language override.
6. **Branch settings** (DB): counters, printers, series prefixes, rate overrides.

**Feature flags:** an in-house, typed flag registry (`flags.ts`: name, owner, type, default, expiry date) evaluated against mode, plan, tenant and branch, stored in a `feature_flag` table and cached in-process. Optionally expose through the **OpenFeature** SDK interface so a flag service (e.g., self-hosted flagd) can be swapped in later. No paid SaaS flag service.
- Flag types: **entitlement** (plan-gated), **release** (gradual rollout, must be removed within 90 days; CI lists expired flags), **ops/kill-switch** (e.g., disable WhatsApp sending).
- **Not flaggable:** INV-1..INV-6, audit logging, tenant isolation, authentication. These are enforced in code and the database and have no off switch.

## 10. Security

| Area | Measures |
|---|---|
| Identity | argon2id password with **optional OTP** via WhatsApp/SMS (D20; recommended on for Owner/Admin/Accountant); **server-side sessions in Postgres** referenced by httpOnly cookies (Secure, SameSite=Lax) with idle timeout (15 min counter, configurable) and absolute expiry; device registration for counter PCs; login-attempt throttling |
| Authorisation | Permission strings defined in the contract (e.g., `sales.invoice.cancel`, `inventory.tag.view_cost`) and enforced by Nest guards; role templates plus custom roles; branch scoping; field masking (purchase cost, PAN/Aadhaar) in serializers |
| Tenant isolation | Forced RLS (Section 5); an automated cross-tenant test suite runs against every endpoint in CI |
| Web | CSRF tokens, strict CSP (no inline scripts), output encoding, upload scanning (ClamAV in the worker, optional), size and type limits, rate limiting per IP, user and tenant |
| Data protection | TLS everywhere (on-prem via DNS-01 certificates, Section 3.2); disk encryption on cloud volumes and on-prem appliances (LUKS); **application-level AES-GCM encryption for PAN/Aadhaar**, with Aadhaar stored masked (last 4 digits) unless legally needed; DPDP Act consent and notice records; retention jobs |
| Secrets | `sops` + `age`-encrypted files in the infra repo; per-deployment keys; no proprietary KMS in the core (a cloud KMS can plug in through an adapter for dedicated customers who want it) |
| Supply chain | Lockfile pinning, Renovate, `pnpm audit`, **Trivy** image scans, **SBOM** (Syft), **cosign** signatures verified by the updater, reproducible builds |
| Platform access | Support impersonation only with tenant-owner consent, time-boxed and fully audited; no shared admin passwords; SSH by short-lived keys |
| Assurance | OWASP ASVS L2 checklist per release; annual third-party penetration test once revenue allows |

## 11. GST integrity rules INV-1..INV-6 enforced in the database

The database enforces these rules so that no API bug, agent-written code path, admin console or maintenance script can bypass them.

| Rule | Database enforcement (recommendation) |
|---|---|
| **INV-1** Single gapless series per branch per FY | **Locked gapless counter** `sales.doc_series(tenant_id, branch_id, doc_type, fy, prefix, next_no)`. The Sales unit of work (as `sales_writer`) allocates **inside the issuing transaction** with `UPDATE sales.doc_series SET next_no = next_no + 1 WHERE … RETURNING next_no - 1`. The row lock serialises issuers, and a rollback also rolls back the counter. A guard trigger allows `next_no` only to go +1 (no rewind or skip), and a **deferred constraint trigger** requires every allocated number to be used by a document before COMMIT. **Postgres SEQUENCEs are not used.** `UNIQUE (tenant_id, branch_id, doc_type, fy, doc_no)`; `fy` must match `doc_date`. **Only tax invoices and credit notes are gapless** (D23); estimates and other vouchers use non-gapless references. `doc_date` is the server date in IST (D29). |
| **INV-2** One billing path | `app_rw` has **no INSERT privilege** on `invoice`/`invoice_line`. Only `sales_writer` may insert, reached by `SET LOCAL ROLE` in `SalesService.issueInvoice()` (app layer; data model v0.2, no SECURITY DEFINER function). The insert guard requires `doc_seq` to equal the number just allocated and forces `issued_at = now()`, so a **client-supplied invoice number is rejected** (D22) and no second series is possible. Child rows (lines, taxes, old metal, payments) can be inserted only in the transaction that issued the parent. CI guard: the build fails if routes, endpoints, tables or functions matching `backup`, `truncate`, `shadow`, `alt_series` (and similar) appear in transactional modules, or if any second writer to `invoice` exists. |
| **INV-3** Immutable audit log | `platform.audit_event` is append-only: `REVOKE UPDATE, DELETE, TRUNCATE` from every application role, and a trigger rejects updates and deletes even from the table owner; a `BEFORE UPDATE OR DELETE` trigger raises an exception. Row-level `AFTER` triggers on audited tables write old/new JSONB, user, branch and IP from `app.*` settings. **Hash chain per tenant:** `hash = sha256(prev_hash ‖ canonical_row)`, computed by `platform.audit_append()` under the per-tenant chain-head lock; `audit_verify()` checks the chain. The chain head is **anchored** to the control plane on every check-in and in the daily owner summary, so tampering (even by a DB superuser on an on-prem box) becomes detectable. |
| **INV-4** No deletion; cancel only via credit note | `REVOKE DELETE, TRUNCATE` on invoices, lines, payments and credit notes for every application role. `BEFORE DELETE` triggers raise an exception. `BEFORE DELETE` / `BEFORE TRUNCATE` triggers apply to every role, including the owner. **Issued bills are immutable:** an invoice's **only allowed change is the guarded status transition `issued → cancelled`** (D35); a `BEFORE UPDATE` trigger allows nothing else (e-invoice IRN/QR data is therefore stored in a separate append-only row linked to the invoice, not by updating it — recommendation), and the transition is allowed only when `cancel_credit_note_id` points at a cancellation credit note for that invoice. `SalesService.cancelInvoice()` requires a reason, issues that credit note (own series), reverses stock and payments, and is audited. **Cancelling an invoice from an earlier FY issues the credit note in the current FY** (D24). A **DDL guard** (event triggers from `000_bootstrap.sql`) blocks DDL and DROP in module schemas for any session user other than `app_migrator`, including superusers, and migrations touching protected tables need a second human approval in CI. |
| **INV-5** Admin alerts on cancellation | The **credit-note outbox trigger** (`AFTER INSERT` on `sales.credit_note`) inserts the `alert.invoice_cancelled` / `alert.sales_return` outbox row in the same transaction, so it cannot be skipped. It is the **only alert writer** (app code never inserts these alerts). The outbox has `ref_type`, `ref_id` and `alert_type` columns with a **partial unique index** `UNIQUE (tenant_id, ref_type, ref_id, alert_type) WHERE alert_type IS NOT NULL`, so an alert for a credit note (`ref_type = 'credit_note'`) is never duplicated (D33). **Thresholds are configurable** (D36); defaults: alert Owner and Branch Admins on **every cancellation** (in-app, push, WhatsApp/SMS/email per settings), **escalate when a branch has more than 5 cancellations in a day**, and send a daily summary **only on days that had cancellations**. |
| **INV-6** Reconciliation | View `reports.series_gaps` (window `lag()` over `doc_no` per series) and a scheduled job that must return zero rows; a cross-check that every issued number appears in the GSTR-1 document summary export (`reports.gstr1_doc_summary`, grouped by `doc_date`); results are shown on the owner dashboard and anchored with the audit head. |

Tests: a dedicated `inv` test suite (Testcontainers Postgres 17) tries every bypass (direct INSERT/UPDATE/DELETE as `app_rw`, TRUNCATE, disabling triggers, owner bypass attempts, concurrent issuing from 30–50 connections, rollback mid-issue) and must pass on every PR. Data model v0.2 already passes 59/59 guardrail tests on PostgreSQL 17.11, and a 30-connection concurrent issue produced invoices 1..32 with no gaps; `tests/issue_invoice_uow.sql` is the reference unit of work that `SalesService.issueInvoice()` must reproduce.

## 12. Observability, done cheaply
- **Logs:** pino JSON with `request_id`, `tenant_id`, `branch_id`, `user_id`; PII is redacted by default.
- **Metrics/traces:** OpenTelemetry SDK. In the cloud, export to a single small VM running **VictoriaMetrics + VictoriaLogs + Grafana** (lighter than Prometheus + Loki). Sample traces at 1–5% (100% for errors).
- **Errors:** the **Sentry free tier** (D26), with PII scrubbing. **GlitchTip** (Sentry-compatible, self-hosted) is the fallback if the free-tier quota is outgrown.
- **Uptime:** **Uptime Kuma** for public endpoints; synthetic "issue a test invoice in a test tenant" every 5 minutes.
- **On-prem:** local log rotation, a health page, and an **opt-in heartbeat** to the control plane (version, disk, backup status, audit head, error counts; no customer PII). This lets support see "backup failing at shop X" before the owner does.
- **Business SLOs:** bill issue p95 < 2 s; tag lookup p95 < 300 ms; backup success; notification delivery rate.
- Expected cost: one 2–4 vCPU VM (≈ ₹750–1,500/month; Section 16) for all cloud tenants.

## 13. CI/CD

**Dev environment (D27):** the owner's own Ubuntu server (2 vCPU, 8 GB RAM) runs the stack with **Docker Compose** (Postgres 17, API, worker, web, Caddy) and hosts a **GitHub Actions self-hosted runner**. With 8 GB, CI jobs run one at a time (runner concurrency 1) and the Testcontainers Postgres uses a small `shared_buffers`; heavy nightly jobs (mutation testing) can move to GitHub-hosted runners if needed. The runner works only for this private repo, never for fork PRs.

**Pipeline per pull request** (GitHub Actions on the self-hosted runner; the same steps run locally through `pnpm verify`):
1. Install (pnpm, Turborepo remote cache) → **lint** (ESLint/Prettier, dependency-cruiser boundaries, no hard-coded UI strings) → **typecheck** (strict).
2. **Contract checks:** Spectral lint on OpenAPI; **oasdiff** breaking-change detection (breaking changes need an ADR and version bump); regenerate clients and fail on drift.
3. **Unit tests** (Vitest) with coverage gates: `domain` ≥ 95% lines and ≥ 80% mutation score (Stryker, nightly); overall ≥ 85%.
4. **Integration tests:** Testcontainers Postgres 17 with the real SQL migrations applied by `migrate.js` (checksums verified), RLS and INV suites, and the golden-bill suite (real anonymised bills from pilot shops must reproduce to the paisa).
5. **Contract tests:** Schemathesis fuzzing of the running API against OpenAPI.
6. **E2E:** Playwright on critical flows (onboarding, rate → tag → estimate → bill → cancel → credit note → reports; the 10-step onboarding wizard and the 'Start billing' gate; billing blocked when the server is unreachable while cached read-only screens still load; printing in a chosen language/numerals to a virtual printer).
7. **Security:** secret scan, `pnpm audit`, Trivy, licence check of dependencies.
8. **Build:** multi-arch images → SBOM → cosign sign → push.

**Delivery:** merge to `main` → staging (shared mode + one dedicated + one on-prem VM) → smoke tests → **shared cloud** rolling deploy → **dedicated** in waves → **on-prem** `beta` channel (pilot shops) → `stable` staged rollout 10% → 50% → 100% over about a week, with automatic halt on error-rate or rollback signals from heartbeats. Database migrations run as a separate `migrate.js` job (as `app_migrator`) with a pre-migration backup.

## 14. Agent-driven development workflow

**Principles:** the spec and contract are the source of truth; tests come before code; small vertical slices; machine-checkable conventions; humans approve at gates where judgement matters (money, tax, security, data).

| Stage | Output | Who | Gate |
|---|---|---|---|
| 1. Feature spec | `docs/specs/<id>.md`: user story, rules, Given/When/Then acceptance criteria, permissions, audit events, edge cases (from product spec IDs) | Spec agent drafts; owner/PM edits | **G1 (human):** owner approves the business rules. Tax rules are reviewed by a CA where relevant. |
| 2. Contract | OpenAPI diff, DB migration plan (tables, RLS, triggers), permission strings, error codes, events | Architect agent | **G2:** automated (Spectral, oasdiff, migration lint) + human architect review for schema/security |
| 3. Tests first | Failing tests: domain unit (golden cases), API integration, contract, e2e for the slice | Test agent | **G3:** automated mutation-score check; human spot-check that the tests encode the acceptance criteria |
| 4. Code | Implementation until green; generated scaffolds via `tooling` generators | Coding agent(s), one module per task | Implementation PRs **may not modify tests or contracts** (a CI check needs an explicit `test-change-approved` label) |
| 5. Review | AI reviewer agent (checklist: conventions, security, N+1, i18n, audit) + automated gates | Reviewer agent + human | **G4 (human)** mandatory for `sales`, `accounts`, `identity`, `tenancy`, `db/migrations`, INV-related code (CODEOWNERS) |
| 6. Release | Changelog, docs and runbook updates, flag cleanup | Release agent | **G5:** staging smoke + pilot sign-off for releases with tax/print impact |

**Bot team (D28):** the stages above are staffed by six bots, with the owner as the human approver at G1 and G4.

| Bot | Responsibilities |
|---|---|
| **Master** | Owns decisions, the task graph and assignment; keeps spec, architecture and data model consistent; runs gate G5 |
| **Data** | SQL migrations (source of truth), RLS, grants and writer roles, guardrail tests, generated Drizzle types, reporting views |
| **Backend** | OpenAPI contracts and NestJS modules (one module per task), unit-of-work code, provider adapters |
| **Frontend** | PWA, design tokens and branding, read-only offline cache, onboarding wizard, print templates and print-language options |
| **QA** | Tests first (stage 3), golden bills, INV/RLS suites, Playwright e2e, review checklist |
| **DevOps** | Docker Compose, self-hosted runner, CI pipeline, backups, observability, release channels |

**Task breakdown rules:** each task is one vertical slice of about a day or less, with a diff of 400 lines or fewer (excluding generated code). It has an explicit list of files and modules it may touch, a link to the spec and contract sections, and a definition of done. Tasks form a dependency graph in the tracker. Parallel agents work on different modules.

**Conventions that make agents reliable:**
- `AGENTS.md` at the root and per package, covering architecture rules, naming, error handling, "never do" lists (no floats for money, no SEQUENCE for documents, no raw SQL outside `db`, no new runtime dependencies without an ADR).
- **Generators** for module, endpoint, migration, page and report.
- A typed error-code catalogue.
- A strict TS config (`noUncheckedIndexedAccess`, no `any`).
- Zod at all boundaries.
- ADRs for every non-trivial choice.
- A golden dataset and seed tenants so every agent can run the full suite locally in minutes.

## 15. Notifications (SMS, WhatsApp, email, push)

### 15.1 Design
- `packages/notifications` defines `NotificationProvider` (`send(message): Promise<DeliveryResult>`, `getStatus`, `handleWebhook`), a **template registry** (logical template → per-channel, per-provider template IDs, DLT template ID, WhatsApp template name/language, variables schema), and a **routing policy** per tenant: e.g., invoice e-bill → WhatsApp utility, else SMS with a link; OTP → WhatsApp authentication, else SMS.
- **Per-tenant sender configuration** (D11): each tenant, or its partner, has its own WhatsApp number/WABA, SMS DLT entity, headers and templates, and email from-address/domain, resolved tenant → partner → platform (Section 20.6).
- Adapters at launch (recommendation): **Meta WhatsApp Cloud API (direct)**, **Fast2SMS**, **MSG91** (or 2Factor) as SMS fallback, **SMTP** (any provider), **Web Push** (free, for staff/owner alerts), and a **"manual WhatsApp" adapter** (generates a `wa.me` click-to-chat link with prefilled text and a signed PDF link for staff to send from the shop's WhatsApp Business app at zero cost).
- All sends go through the outbox (the API writes rows; the worker as `app_worker` enqueues them to pg-boss in the `pgboss` schema, D37), with `ref_type`/`ref_id`/`alert_type` for deduplication (D33), idempotency keys, retries with back-off, delivery webhooks, per-tenant wallet or quota metering, and opt-out handling (marketing).
- **DLT compliance:** every commercial SMS in India must use a registered Principal Entity (PE), header (sender ID) and content template on a DLT portal. Platform messages (login OTP, system alerts) go under **your** PE. Shop-branded messages (e-bill, order ready) require the **shop's own PE registration** (one-time fee; see below) and header, or a platform-branded header. Confirm the permitted model with the chosen provider. The admin UI stores each tenant's PE ID, headers and template IDs.
- **WhatsApp model:** become a **Meta Tech Provider** and use **Embedded Signup**, so each shop connects its own WhatsApp Business Account and number. The shop pays Meta directly (cost off your books), or you resell with a wallet. A single platform number can serve shops that do not want their own.

### 15.2 Indicative prices (verify before committing; exclusive of 18% GST)

**WhatsApp Business Platform: Meta's India rates per delivered message (effective 1 Oct 2026)**
| Category | Meta rate (India) | Typical use in this product |
|---|---|---|
| Utility | **₹0.115** | E-bill/invoice PDF, order/repair status, payment receipt, cancellation alert |
| Authentication | **₹0.115** | Login OTP |
| Service (replies within 24 h window) | First **1,000/month free per number**, then ₹0.115 | Customer queries |
| Marketing | **₹0.8631** | Festival offers, new collections, rate broadcasts |

Volume tiers only start at crores of messages per month, so they are irrelevant here. Meta changes rates only at quarter starts (next possible: 1 Jan 2027).

**WhatsApp via resellers (BSPs), for comparison:**
| Provider | Monthly fee | Utility / marketing per message |
|---|---|---|
| **Meta Cloud API direct** | **₹0** | ₹0.115 / ₹0.8631 |
| Interakt (Growth) | ~₹2,200–2,799 | ₹0.150 / ₹0.958 |
| AiSensy (Basic) | ~₹1,350–1,500 | ₹0.145 / ₹1.09 |
| Wati (Growth/Pro) | ~₹2,199–6,499 | ₹0.1495 / ₹0.9926 |
| Gupshup | — | Meta rate "at actuals" + ~$0.001/msg |

**SMS (DLT, India):**
| Provider | Indicative price per SMS | Notes |
|---|---|---|
| **Fast2SMS** | ₹0.25 (recharge ₹100–3,999) → ₹0.21 (₹4,000+) → ₹0.17 (₹14,000+) → ₹0.11 (₹6 lakh+) | Lowest entry barrier; slab rates have validity periods |
| MSG91 | ₹0.25 (5,000 pack) → ₹0.16 (9.6 lakh pack); custom from ~₹0.13 | Good OTP product and APIs |
| 2Factor | Transactional ₹0.15 (≤1 lakh/month) → ₹0.10 (10 lakh+); OTP ₹0.17 → ₹0.12 | OTP-focused; also offers WhatsApp at near-Meta rates |
| Exotel | "From ₹0.18" | If voice is also needed |
| DLT one-time | ~₹5,900 incl. GST per Principal Entity registration (renewal terms vary by portal) | Per shop if shop-branded SMS; DLT scrubbing (~₹0.025/SMS) is usually embedded in the price |

**Self-hosted or free options (realistic):**
- **wa.me click-to-chat + WhatsApp Business app** (free; manual send by staff). This is the default for Lite-plan shops.
- **Web Push** (PWA) for staff and owner alerts: free.
- **Email** for invoices and reports: free to near-free (any SMTP provider, or self-hosted Postal/Stalwart for dedicated/on-prem).
- **Not recommended:** unofficial WhatsApp Web automation libraries (Baileys, whatsapp-web.js), which violate WhatsApp's terms and get numbers banned, and sending bulk SMS from a SIM/Android gateway, which breaches TRAI commercial-communication rules.

**Cheapest picks (recommendation):**
- **WhatsApp:** Meta Cloud API direct (₹0.115 utility/OTP; no BSP fee) via Embedded Signup.
- **SMS:** Fast2SMS for small volumes (₹0.25 → ₹0.21), with MSG91/2Factor as a second adapter for redundancy and negotiated ₹0.13–0.15 at scale.
- **Rule of thumb:** a WhatsApp utility message (₹0.115) is now **cheaper than a transactional SMS** (₹0.15–0.25) and can carry the invoice PDF, so make WhatsApp the default and SMS the fallback.

**Indicative messaging cost per shop (assumption: 600 bills/month, 50 orders/repairs, 100 OTPs, one 2,000-recipient festival campaign):** WhatsApp utility 700 × ₹0.115 ≈ ₹81; OTP 100 × ₹0.115 ≈ ₹12; SMS fallback 10% ≈ 80 × ₹0.25 ≈ ₹20; campaign 2,000 × ₹0.8631 ≈ ₹1,726. **Transactional messaging ≈ ₹110/month; marketing dominates.** Make marketing a **pass-through wallet**, not part of the plan price.

## 16. Rough monthly infrastructure cost per shop (estimate)

**Assumptions:**
- FX ₹96/US$ and ₹106/€ (verify).
- Foreign-billed services add 18% GST under reverse charge (input-tax-credit eligible). Indian providers quote INR inclusive of GST where noted.
- Typical shop: 1 branch, 3–8 users, ~600 invoices/month, 1–3 GB of database per year, 2–5 GB of images/PDFs per year.
- Messaging is excluded (Section 15). Staff/ops labour is excluded; it is the larger real cost for dedicated and on-prem.
- List prices as of Oct 2026; promotional prices are noted.

### 16.1 Candidate providers (indicative list prices)
| Provider (region) | Plan | Price | ≈ ₹/month incl. GST | Notes |
|---|---|---|---|---|
| Hetzner (EU: DE/FI) | CX23: 2 vCPU / 4 GB / 40 GB | €5.49 + €0.50 IPv4 | ≈ ₹750 | Best price/performance; **no India DC** (~120–150 ms latency; data outside India); prices rose 15 Jun 2026; some plans showed "unavailable" in Oct 2026 |
| Hetzner (EU) | CX33: 4 vCPU / 8 GB / 80 GB | €8.49 + €0.50 | ≈ ₹1,125 | |
| Contabo (Mumbai) | Cloud VPS S: 4 vCPU / 8 GB / 100 GB | $6.60 | ≈ ₹750 | Very cheap India DC; unmanaged; variable performance reported |
| Hostinger (Mumbai) | KVM 2: 2 vCPU / 8 GB / 100 GB | ₹699 (promo term) | ≈ ₹699 | INR billing with GST invoice; renewal prices higher |
| E2E Networks (Delhi/Mumbai) | C2.2: 2 vCPU / 4 GB / 80 GB | ₹1,499 | ≈ ₹1,499 | Indian, MeitY-empanelled, INR/GST invoice; prices revised Aug 2026 |
| E2E Networks | C2.4: 4 vCPU / 8 GB / 160 GB | ₹2,799 | ≈ ₹2,799 | |
| DigitalOcean (Bangalore BLR1) | Basic 2 GB / 1 vCPU · 4 GB / 2 vCPU | $12 · $24 | ≈ ₹1,360 · ₹2,720 | Same price worldwide; excellent DX |
| AWS Lightsail (Mumbai) | 2 GB · 4 GB bundles | ~$12 · ~$24 (some trackers show $10 · $20) | ≈ ₹1,140–1,360 · ₹2,270–2,720 | Halved transfer allowance in Mumbai |
| Google Cloud (Mumbai) | e2-medium: 2 vCPU / 4 GB | ~$27.44 + disk | ≈ ₹3,100+ | Hyperscalers are 2–4× VPS prices for the same capacity |
| Backblaze B2 | Object storage | $6.95 per TB-month | ≈ ₹8 per 10 GB | Free egress up to 3× stored |
| Cloudflare R2 | Object storage | $0.015 per GB-month, no egress fees | ≈ ₹17 per 10 GB | Good for update-bundle distribution (zero egress) |

### 16.2 Estimated cost per shop by deployment mode
| Mode | Reference setup (estimate) | Monthly total (estimate) | Per shop (estimate) |
|---|---|---|---|
| **Shared multi-tenant cloud, India DC** | 2 × app/worker (E2E C2.4) + PG primary + standby (2 × C2.4) + 1 × ops/observability/control plane (C2.2) + ~300 GB backups (B2) + DNS/email | ≈ ₹13,000–14,000 for ~200 shops | **≈ ₹65–70/shop** at 200 shops; ≈ ₹140–150 at 50 shops (smaller cluster ≈ ₹7,200); ≈ ₹35–45 at 1,000 shops (≈ ₹40k cluster) |
| Shared cloud, EU budget (Hetzner) | Same topology on CX33 / CX23 + B2 | ≈ ₹5,500 for ~200 shops | ≈ ₹25–30/shop. Cheapest, but latency and data-residency trade-offs; good for staging/CI/control plane |
| Shared cloud, hyperscaler Mumbai | Same topology on AWS/GCP/Azure VMs + storage | ≈ ₹40,000–60,000 (rough) | ≈ ₹200–300/shop at 200 shops |
| **Dedicated cloud instance** | 1 VM running the full Compose stack (2 vCPU / 4–8 GB) + offsite backups + monitoring share | VM ₹700–2,720 + backups ₹20–50 + monitoring/control-plane share ≈ ₹50 | **≈ ₹800–2,800/customer** (Hostinger/Contabo at the low end, E2E ≈ ₹1,600, DO/Lightsail ≈ ₹2,800), **plus ops time** (patching and upgrades are automated, but expect 0.5–1 h/month per customer) |
| **On-premise** | Shop's own PC or a small mini-PC/server (customer-paid hardware); your side: offsite backup 10–20 GB, update distribution, control plane share | **Your cost ≈ ₹20–60/shop/month** (backup ≈ ₹10–20, R2 update egress ≈ ₹0, control plane share ≈ ₹10–20, DNS-01 certificates free) | **≈ ₹20–60/shop** for you. Customer one-time hardware (rough, unsourced): ₹15,000–35,000 for a mini-PC + SSD + UPS, or ₹0 if an existing PC is suitable (Linux appliance recommended; Windows + WSL2/Docker Desktop is supported but heavier) |

**Reading the numbers:** infrastructure is **not** the main cost. Shared cloud at any reasonable scale is under ₹150/shop/month, and on-prem is nearly free to run. The real costs are **support and onboarding, messaging (marketing campaigns) and ops for dedicated/on-prem**.

## 17. Pricing implications (recommendations to validate with pilot shops)
1. **Shared cloud is the default and the margin engine.** An entry plan in the region of ₹799–1,499 per branch per month (+18% GST) covers infra (≈ ₹70) with very high gross margin, so price for value and support cost, not infra.
2. **On-prem pricing:** either a **one-time licence plus annual maintenance/updates** (AMC; a familiar model for Indian jewellers using desktop software), or an **annual subscription with an offline licence**. Offsite backup and the update channel are included only while the AMC/subscription is active. Optional hardware appliance sold at cost plus setup.
3. **Dedicated cloud** only for Pro/Enterprise, with a premium of at least ₹2,500–5,000/month over shared to cover VM, ops time and change windows.
4. **Messaging as a pass-through wallet** (Meta/DLT cost plus a small margin), or **bring-your-own WABA/DLT**. Include a small bundle (e.g., 500 utility WhatsApp messages ≈ ₹58 cost) in paid plans. Never bundle marketing messages.
5. **Plan gates align with architecture costs:** branches, counters/users, modules (orders/repairs, refinery, accounting), cloud mirror for on-prem, dedicated mode, e-invoice, API access.
6. **Annual prepay discount** (15–20%) improves cash flow and lowers churn. Use UPI AutoPay/e-mandate for monthly plans.
7. **White-label fee (D11)** as a pricing option (amounts are suggestions to validate):
   - **Tenant add-on "Own brand":** custom domain, own logo/colours/app name, own senders, platform attribution removed, for about ₹500–1,500 per month.
   - **Partner/reseller programme:** one-time onboarding and brand setup (about ₹25,000–1,00,000), a monthly partner platform fee, and a per-tenant wholesale price (for example 40–60% of retail list) that the partner marks up.
   - **Full-rebrand pack for dedicated/on-prem:** a one-time brand-pack build plus an annual fee covering brand-pack maintenance on each release.
8. **Run cost per shop well under ₹150/month** lets a free trial or a free single-counter "starter" tier be sustainable if needed for market entry. This is worth testing against legacy desktop competitors.

## 18. Sources (accessed on or around 20 Oct 2026; all prices indicative)
- Meta India WhatsApp rates (1 Oct 2026): Leapstream, https://leapstream.in/blog/whatsapp-business-api-pricing-india ; Mint, https://www.livemint.com/technology/whatsapp-business-platform-gets-costlier-from-today-what-indian-businesses-need-to-know-about-new-messaging-charges-11790836512655.html ; Meta pricing overview, https://whatsappbusiness.com/products/platform-pricing/
- BSP fees and markups: https://jeedesigns.com/insights/wati-vs-aisensy-vs-interakt-pricing/ ; https://xreach51.com/whatsapp-bsp-markup-explained/ ; AiSensy pricing, https://aisensy.com/pricing
- SMS prices: Fast2SMS, https://www.fast2sms.com/bulk-sms-pricing ; 2Factor, https://2factor.in/v4/pricing.html and https://2factor.in/v3/bulk-sms-pricing ; comparison (MSG91, Exotel), https://appadvisor.in/blogs/best-sms-otp-gateway-india-pricing-dlt ; market ranges and DLT scrubbing, https://www.techtonetworks.com/post/bulk-sms-charges
- DLT registration fee: https://www.enablex.io/insights/a-step-by-step-guide-to-dlt-registration/ ; https://www.infobip.com/docs/essentials/asia-registration/dlt-registration
- Hetzner prices (15 Jun 2026 adjustment): https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ ; availability note, https://hostmath.dev/guides/hetzner-price-increase-2026
- DigitalOcean droplets and BLR1 availability: https://www.digitalocean.com/pricing/droplets ; https://docs.digitalocean.com/platform/regional-availability/
- India VPS comparison (E2E, Hostinger, Contabo, Lightsail, GCP, Linode, Vultr): https://indiagpu.com/vps/ ; E2E pricing update, https://docs.e2enetworks.com/docs/myaccount/billing/pricing-update-july-2026/
- AWS Lightsail: https://aws.amazon.com/lightsail/pricing/
- Object storage: Backblaze B2, https://www.backblaze.com/cloud-storage/pricing ; Cloudflare R2, https://developers.cloudflare.com/r2/pricing/

## 19. Open architecture questions
1. Expiry policy for on-prem licences (Section 6.1): is read-only after grace acceptable to the owner?
2. Hosting region for shared cloud: India DC required (latency, DPDP comfort, customer perception) or EU budget acceptable for early pilots?
3. Target on-prem hardware: a supplied Linux mini-PC appliance (recommended) vs any customer Windows PC?
4. WhatsApp model: each shop's own WABA via Embedded Signup (recommended) vs a single platform number?
5. Which label printer and scale models do pilot shops use (drives print-agent drivers)?
6. Accept NestJS (conventions) over plain Fastify (leaner)? (Drizzle is settled as types-only over SQL-first migrations, D16.)
7. New brand name (needed for domains, certificates, DLT headers and the design system).
8. Partner commercial model: does the partner bill its shops (wholesale), or do we bill shops on the partner's behalf with a revenue share?
9. May partners see tenant business data, or only the tenant registry and billing (recommended: only with a consented, audited support session)?
10. For full rebrands, will partners supply their own Windows code-signing certificate for the print-agent and updater, so the publisher name shows their brand?

## 20. White-labelling (decision D11)

*(Added in v0.2 as Section 20 so existing section references stay stable; it logically follows Section 5.)*

### 20.1 Partner (reseller) level above tenants
- Hierarchy: **Platform → Partner (optional) → Tenant → Company (GSTIN) → Branch.** `platform.partner` holds legal name, GSTIN, status, contract terms, default branding profile, default senders and allowed plans. `platform.tenant.partner_id` is nullable (null = direct customer of the platform).
- **Partner roles:** Partner Owner/Admin, Partner Support and Partner Finance. Through a **partner portal** (a mode of the same web app, served on the partner's domain), partners can onboard tenants, manage branding, templates and domains for their tenants, see subscriptions and usage, and get support access.
- **Data boundary:** partner users see only `platform.*` registry and billing rows where `partner_id` matches (RLS on `app.partner_id`). They **cannot read tenant business data** (sales, customers, stock) except through a tenant-consented, time-boxed, audited support session.
- **Partner billing:** handled by SaaS Billing (wholesale price per tenant, partner platform fee, white-label fees, optional revenue share).

### 20.2 Per-tenant branding
- **Branding profile** (`platform.branding_profile`; owner = platform | partner | tenant; versioned, draft → published): app name and short name; logos (light/dark, square, wide); favicon; PWA icons (192/512/maskable, generated from one source upload); **colour tokens** (primary, accent, surface, text, success/warning/danger, each with dark-mode variants); radius and density; **fonts** (curated, locally bundled list including Noto Indic families, or an uploaded WOFF2 with licence confirmation; Indic fallbacks always kept); **login page** (background image, headline, support phone/WhatsApp, terms/privacy links); email header/footer; legal footer and support contacts; attribution flag ("Powered by …" shown or hidden per contract).
- **Resolution order: tenant → partner → platform default**, merged **field by field** (a tenant that sets only a logo inherits the partner's colours). The resolved profile is cached per host (in-process LRU + ETag) and invalidated on publish.
- **Host-based resolution (before login):** request `Host` → `platform.domain` → tenant or partner → branding. Platform subdomains (`<tenant>.<platform-domain>`, `<partner>.<platform-domain>`) work the same way.
- **Served dynamically per host** by the Platform module's Branding service:
  - `/branding.css`: generated `:root { --color-primary: …; … }` plus `@font-face` rules;
  - `/manifest.webmanifest`: `name`, `short_name`, `theme_color`, `background_color`, icons;
  - `/icons/*`, `/favicon.ico`, `apple-touch-icon`;
  - `index.html`: the SPA shell is a template rendered per host with title, meta theme-color, manifest link and preloaded branding CSS, so the first paint is already branded with no flash of platform branding.
  - Asset URLs carry the branding version for cache-busting. Each custom domain is a separate origin, so the PWA installs with the tenant's own name and icon.

### 20.3 Custom domains with automatic TLS
1. A tenant or partner adds `billing.lakshmijewellers.in` in settings. The UI shows a **CNAME target** (`edge.<platform-domain>`; A/AAAA records for apex domains) and a **TXT verification token** (`_verify.<domain>`).
2. A Platform job checks DNS (TXT token plus routing to our edge) and marks the domain `verified`. It re-checks periodically; a domain that stops resolving to us is suspended.
3. **Caddy on-demand TLS** issues certificates (Let's Encrypt, with ZeroSSL as fallback) at the first TLS handshake, but only after asking the API:

```
{
  on_demand_tls {
    ask http://api:3000/internal/tls/allow   # 200 only for verified, active domains
  }
}
https:// {
  tls { on_demand }
  reverse_proxy api:3000
}
```

4. The `ask` endpoint prevents certificate abuse and protects ACME rate limits. Platform subdomains use one **wildcard certificate via DNS-01**. Multiple Caddy instances share certificate storage (shared volume or a Postgres-backed CertMagic storage plugin, to be evaluated). HSTS is enabled only after verification. Domain counts are limited per plan.
5. On-prem and dedicated: the LAN/instance hostname can sit under the partner's or tenant's domain, using the DNS-01 delegation from Section 3.2 (`_acme-challenge` CNAME to our ACME DNS).

### 20.4 Rule: no hard-coded brand or colours (enforced from day one)
- `packages/design-tokens` defines the typed token schema (Zod), platform defaults and a generator that emits CSS variables. Tailwind's theme maps every colour, font and radius to `var(--…)`; shadcn/ui components already consume CSS variables.
- Components read brand text through `useBrand()` (app name, support contacts) and i18n messages with a `{appName}` placeholder. **No literal product names in code.**
- **CI guards:** an ESLint/stylelint rule bans hex/rgb/hsl literals and Tailwind palette or arbitrary colour classes (`bg-blue-600`, `text-[#…]`) outside `design-tokens`; a grep guard bans brand strings; **visual-regression tests** (Playwright screenshots) run key screens under **three sample brands** (light, dark-primary, high-contrast) to prove the UI is fully themeable.
- **Accessibility:** on publish, token sets are checked for WCAG AA contrast, foreground colours are auto-generated where possible, and publishing is blocked if the check fails.

### 20.5 Versioned per-tenant print templates
- `platform.print_template`: owner (platform | partner | tenant), kind (`invoice`, `estimate`, `credit_note`, `receipt_thermal`, `tag_label`, `order_receipt`, `repair_receipt`), format (A4, A5, 80 mm, 58 mm, label W×H), engine (`html` for PDF/browser, `escpos` for thermal, `tspl`/`zpl` for labels), **version**, status (draft → published → retired), body, variable-schema version, author, published_at.
- Templates use message keys rather than literal labels, so one template prints in **any chosen language and numeral system per print** (D30). The print dialog offers the tenant/branch default and lets the user pick another; the language used is stored with the print/audit event.
- **Published versions are immutable.** Editing creates a new draft version. Resolution follows the same order (**tenant → partner → platform default**) per kind and format.
- Every issued document stores the **template ID and version** (and the PDF hash), so reprints reproduce the original exactly, even after the template changes.
- **Template linter:** an invoice or credit-note template cannot be published unless it includes the mandatory GST fields (seller GSTIN, invoice number and date, buyer details/GSTIN where applicable, place of supply, HSN, taxable value, CGST/SGST or IGST breakup, total in words, HUID per hallmarked item).
- **Safety:** templates are sandboxed (logic-less variables and loops only; no JavaScript; assets only from the branding store). There is a live preview with sample data, and label templates get a calibration print.

### 20.6 Per-tenant WhatsApp / SMS / email senders
- `notifications.sender_config` (owner tenant | partner | platform; channel; provider; encrypted credentials; status) holds:
  - **WhatsApp:** WABA ID, phone-number ID, display name, approved template names per language (Embedded Signup per tenant or partner);
  - **SMS:** DLT Principal Entity ID, headers (sender IDs), DLT template IDs, provider account;
  - **Email:** from-name, from-address, sending domain with **SPF/DKIM/DMARC verification** (records shown in the UI, checked by a job), reply-to.
- Resolution: **tenant → partner → platform.** A tenant can explicitly choose "use partner sender" or "use platform sender". Silent fallback to another brand's sender is not allowed for shop-branded messages.
- Message templates use brand variables (`{appName}`, `{shopName}`, `{supportPhone}`). Costs are metered per sender owner for wallet billing (Section 15).

### 20.7 Full rebrand for dedicated and on-prem
- **Same images, branded at runtime.** A signed **brand pack** (tokens, logos, icons, fonts, strings and legal text, support contacts, default templates, sender defaults, update-channel alias) is installed with the licence and stored in the instance's Platform module.
- **Everything visible is brand-driven:** web app, login, PWA, emails, PDFs (including PDF metadata), error pages, installer screens, the updater UI, the print-agent tray name and icon, default hostnames, and licence/expiry screens.
- **Residual platform identifiers** (Docker image names, registry host, code-signing publisher) are hidden where feasible: a partner registry alias, and the partner's own code-signing certificate (open question 10).
- Platform attribution can be removed per contract.

### 20.8 Effects on other sections
- Tenancy (Section 5): partner scoping adds `app.partner_id` for platform-schema RLS.
- Config (Section 9): new partner layer.
- Printing (Section 3.3): versioned templates.
- Notifications (Section 15): sender configs.
- Pricing (Section 17): white-label fee.
- Agent workflow (Section 14): visual-regression tests under sample brands are part of gate G4 for any UI change.

## 21. Guided onboarding wizard (decision D32)

A **resumable 10-step stepper** owned by Platform (`platform.onboarding_progress`: tenant, step, status `pending | done | skipped`, data snapshot, updated_by/at). Each step saves as it goes, so the owner can leave and resume on any device; each step calls the owning module's normal API (no wizard-only write paths).

| Step | Content | Owning module | Required for "Start billing" |
|---|---|---|---|
| 1 | **Shop profile** (legal and trade name, address, contacts, logo) | Platform | **Yes** |
| 2 | **GST/GSTIN** with validation (format, checksum, state code; online lookup when available) and the **invoice series** (prefix per branch/FY) | Platform / Sales | **Yes** |
| 3 | **Branches** (GSTIN optional, needed only for branches in other states) | Platform | No |
| 4 | **Metals and purities** (seeded defaults: 24K 999, 22K 916, 18K 750, silver 925 …) | Masters | **Yes** |
| 5 | **GST rates with effective dates** (seeded platform defaults to confirm or override; managed in Settings afterwards, D31) | Masters | **Yes** |
| 6 | **Today's rates** (sale and old-metal rates per purity) | Rates | **Yes** |
| 7 | **Users and roles** (role templates, invite by mobile/email) | Platform | No |
| 8 | **Branding with live preview** (logo, colours, app name; Section 20) | Platform (Branding) | No |
| 9 | **Printers and print language/numerals** with a **test print** (print-agent pairing, label calibration) | Platform / print-agent | No |
| 10 | **CSV/Excel import with a dry run** (customers, items, opening stock, balances; Section 6.8 of the spec) | Each owning module | No |

- **"Start billing"** is enabled only after steps **1, 2, 4, 5 and 6** are done; the Sales API enforces the same check (`onboarding.billing_ready`), so the gate cannot be bypassed from the client.
- A **setup checklist card** stays on the dashboard until all 10 steps are done or explicitly skipped.
- Today's rates (step 6) must be re-entered daily as usual; the wizard only ensures the first day has them.
