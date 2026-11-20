# Frontend Plan — Jewellery Retail SaaS (`apps/web`)

**Status:** Draft v0.1, 20 Oct 2026 (IST). Planning only. No code has been scaffolded, committed or deployed.
**Inputs read:** `jewellery_saas_spec.md` (v0.4, D1–D12), `jewellery_saas_architecture.md` (§3, 3.1–3.3, 4, 4.1, 7, 9, 10, 13, 14, 19, 20), `jewellery-data-model/` (README, `015_branding.sql`), legacy `outline/billing_frontend-main` (feature reference only, per D5).
**Stack:** Vite + React + TypeScript (strict) PWA · TanStack Router / Query / Table · React Hook Form + Zod · shadcn/ui (Radix) + Tailwind · Dexie + Workbox (vite-plugin-pwa) · FormatJS (react-intl) · decimal.js through `packages/domain` · Orval-generated client from OpenAPI 3.1 (`packages/contracts`).

---

## 0. Ground rules (non-negotiable, from the spec)

1. **Nothing looks like AuSales (D5).** No legacy JSX, SCSS, layout, icons or menu structure is ported. Legacy code is read only to list features and fields.
2. **No hard-coded brand or colours (D11, WL-7).** Every colour, font, radius, spacing and density value comes from CSS variables. Brand text comes from `useBrand()`. CI bans hex/rgb/hsl literals, Tailwind palette classes (`bg-blue-600`) and arbitrary colours (`text-[#…]`) outside `packages/design-tokens`, plus a grep guard for brand strings.
3. **No hidden modes (D2, INV-2).** One bill-creation path. No long-press gestures, secret prompts, alternate endpoints or alternate stock lists. CI greps for `backup`, `truncate`, `authenticatepass`, `huid-stock-list`, `Drang` in `apps/web`.
4. **The client never numbers tax invoices (INV-1)** and never computes authoritative money. The UI shows a *preview* computed with `packages/domain` (decimal.js). The server result is the truth. Never `parseFloat`/`toFixed` on money or weight.
5. **No hard-coded UI strings.** Every string is in a message catalogue. CI fails otherwise.
6. **Cookie sessions only** (HttpOnly, SameSite=Lax, CSRF token header). No token in `localStorage`.
7. Prints and labels are **server-resolved versioned templates** (WL-4), not React components.

---

## 1. Feature and screen inventory

Legend: **Ref** = a legacy screen exists to mine for fields (`src/pages/<folder>`). **Gap** = nothing in legacy; new. **Fix** = legacy existed but was wrong or hidden. Phase = spec §9 roadmap.

### 1.1 Shell, identity and platform (module: Platform)
| Screen | Ref / Gap | Phase | Notes |
|---|---|---|---|
| Branded login (password + mobile OTP) | Ref `auth/login` | 1 | Login page content from branding profile (bg image, headline, support WhatsApp). |
| TOTP MFA enrol / challenge | Gap | 1 | Required for Owner/Admin/Accountant. |
| Forgot / reset password | Gap | 1 | Legacy had none. |
| Session/device manager, counter-PC registration | Gap | 1 | |
| Signup + onboarding wizard (GSTIN verify, first branch, seed metals/purities/tax, today's rate, optional sample data) | Gap | 1 | §6.2. |
| Branch & cash-counter picker (with counter password) | Ref `billingpopup` | 1 | Becomes a context switcher in the top bar, not a popup. |
| Command palette (Ctrl+K) + keyboard shortcut sheet | Ref `home`, `app_constants.js` | 1 | Replaces "home shortcut creation". Legacy shortcuts collide (`Ctrl+Shift+S` used 4×); rebuild a conflict-free map. |
| Owner dashboard | Fix `dashboard` (placeholder) | 1 (P1) | KPIs: today's sales, metal-wise, sales vs purchase, cancellations, low stock. |
| Notifications / alerts centre | Gap | 1 | INV-5 cancellation alerts land here. |
| Audit log viewer + auditor export | Gap | 1 | §6.6. Read-only, filter by doc/user/branch. |
| Organisation: locations, branches, departments, designations | Ref `organization` | 1 | |
| Staff | Ref `staff` | 2 | PAN masked (last 4). No Aadhaar is collected. |
| Users | Ref `user` | 1 | |
| Roles & permissions matrix (menu × CRUD + action permissions + field masking) | Ref `userrole`, `menupermission` | 1 | Extended with action perms (`sales.invoice.cancel`, `inventory.tag.view_cost` …). |
| Company (GSTIN, PAN, banks; GSTIN/IFSC lookup) | Ref `company` | 1 | |
| Tenant settings (state, rounding, return-policy days, languages, pagination) | Ref `appconfig` | 1 | |
| Branding editor (logos, colour tokens with live preview + WCAG check, fonts, login page, PWA icons) | Gap | 1 | WL-2. Draft → publish. |
| Custom domains (CNAME/TXT instructions, status) | Gap | 1 (P1) | WL-3. |
| Print-template manager (versions, live preview, linter errors, label calibration) | Gap | 1 | WL-4. |
| Notification senders (WhatsApp/SMS-DLT/email with SPF/DKIM status) | Gap | 1 (P1) | WL-5. |
| Data import (templates, upload, dry-run, error table, commit) | Gap | 1 | §6.8. |
| Data export / backup status | Gap | 1 | §6.7. Always available, even when the subscription has lapsed. |
| Subscription & plan, invoices, payment method | Gap | 1 | Module: SaaS Billing. Read-only banner on lapse. |
| Print-agent pairing & printer setup | Gap | 1 | §3.3. |
| Partner portal (tenants, branding, domains, templates, billing, consented support sessions) | Gap | 2 | WL-1. Same app, "partner mode" by host. |
| Platform admin console | Gap | 2 | §6.9. Could be the same app with a platform role; see Q-list. |
| Maintenance / 404 / 500 / offline / licence-expired pages | Ref `session` | 0 | All branded. |

### 1.2 Masters & rates (Masters, Rates)
| Screen | Ref | Phase |
|---|---|---|
| Metals & purities (header-visible flag) | `metalcreate` | 1 |
| Daily metal rates (effective-dated, per branch/purity; publish) + rate ticker in top bar | `metalrates`, `dailymetal` | 1 |
| Old-metal rates | `oldmetalrate` | 1 |
| Carat (diamond) rates | `createtag/Caratrate` | 2 |
| Tax / HSN rules (effective-dated) | `Taxs`, `taxaudit` | 1 |
| Items & sub-items (MC/wastage calc types, HSN, HUID charge, image) | `itemmaster`, `subitem` | 1 |
| Stone/diamond standards (shape, cut, clarity, colour, cent group) | `standard` | 1 |
| Tag types | `createtag/Tag` | 1 |
| Range stock | `rangestock` | 2 |
| Repair types | `repairtype` | 2 |
| Customer value addition / Designer value addition | `valueadditioncustomer`, `valueadditiondesigner` | 1 / 2 |
| Customers (+360° view: bills, orders, advances, balances), customer groups | `customer`, `customergroup` | 1 |
| Account heads (vendors/designers: addresses, contacts, banks, opening ₹ + g) | `accounthead` | 1 |
| Cash counters | `cashcounter` | 1 |
| Floors/counters, boxes, box-weight verification | `infrastructure`, `box`, `boxweightverification` | 2 |
| Rate-feed approval | Gap | 3 |

### 1.3 Inventory
| Screen | Ref | Phase |
|---|---|---|
| Lots (inward, tagging progress) | `lot` | 1 |
| Item tagging (single + bulk grid; HUID required unless exempt; stones/diamonds; scale weight from print-agent) | `itemtag` | 1 |
| Tag details / lookup (scan-first) | `tagdetails` | 1 |
| Tag update (single/multiple) | `Tagupdate` | 1 |
| Duplicate tag print (audited) | `dublicatetag` | 1 |
| Stock list (one list only) | `stocklist` | 1 (Fix: remove alternate list) |
| Stock ledger | `stockledger` | 1 |
| Stock transfer (transfer → approve → receive → return, scan) | `stocktransfer` | 2 |
| Stock-take / cycle count with variance approval | Gap | 3 |
| HUID register | Gap | 1 (report) |

### 1.4 Sales (counter mode)
| Screen | Ref | Phase |
|---|---|---|
| **Unified counter workspace**: Estimate ↔ Bill on one engine (tag scan, stones/diamonds, old-gold exchange, sales return, advance/suspense, chit/voucher, split payments, discount with min-price guardrail, GST intra/inter) | `estimatebilling`, `invoice`, `estimationedit`, `estimatebillingapproval` (4 copies, ~29k lines) | 1 — one component tree, not four |
| Estimate list / edit / merge into bill | `estimationedit` | 1 |
| Invoice list & view, reprint (stamped DUPLICATE) | `invoice` | 1 |
| Cancel invoice → credit note (reason, permission) | Gap | 1 |
| Credit notes / debit notes | Gap | 1 |
| "Pending issue" queue (offline bills awaiting server numbering) | Gap | 1 |
| Misc billing / issue | `miscissue` | 2 |
| Customer credit/debit, reminders | `creditdebit` | 1 (P1) |
| PAN capture & cash-limit warnings, e-invoice IRN status | Gap | 1 / 2 |
| WhatsApp/SMS e-bill send | Gap | 1 (P1) |

### 1.5 Orders & repairs, purchases, refinery, accounts, HR, approvals
| Area | Screens (Ref) | Phase |
|---|---|---|
| Orders | Order create/list, designer assignment, attachments, advances, receive finished, lot from order (`order`); production Kanban (Gap) | 2 |
| Repairs | Create, vendor issue/receipt, customer delivery, payment (`repairmanagement`, `repairissuecustomer`) | 2 |
| Purchases | New purchase (`newpurchase`), old purchase from customers (`oldpurchase`; P1 in Phase 1), purchase return (Gap), purity test record (Gap) | 1–2 |
| Vendor settlement | Vendor payment 4 modes + rate-cut (`newvendorpayment`, `vendorpayments`), discount (`vendordiscount`), ledger (`vendorledger`) | 2 |
| Refinery | Bagging (`transfercreation`), melting issue/receipt, purification issue/receipt, loss reconciliation (Gap) | 3 |
| Accounts | Account groups (`accountgroup`), advances (`advancepayment`), suspense (`suspense`); vouchers, day book, cash/bank book, bank reco, TB, P&L, BS, GSTR-3B, Tally export (all Gap) | 1 (advances P1) / 3 |
| HR & incentives | Incentive slabs (`incentive`), counter targets (`target`), per-staff targets & payout ledger (Gap) | 2 |
| Approvals | Inbox (my pending), approval types & rules (Fix: hidden `approvaltype&rule`), requisition/goods-on-approval + receipt (`requisitionapproval`), estimate/billing approval (Fix: hidden) | 1 (P2) / 2 |
| Chit / gold-savings scheme | Gap (only a manual field + unused third-party endpoint) | 3 |

### 1.6 Reports (read-only; one generic report runner)
All ~30 legacy reports collapse into **one report-runner page** driven by report metadata (filters schema, columns, totals, export), not 30 bespoke screens.
- Sales: daily sales, sales details, by customer, customer sale, metal/item/purity-wise, cash-counter collection, estimation.
- Stock: tag report, item-wise, summary, tag-wise, lot, daily stock by item/sub-item/metal/purity/designer, range stock.
- Purchase: purchase, item-wise, vendor-wise (pure g), old purchase.
- Repairs: issue customer. Staff: incentive % / amount.
- **Gap (new):** GSTR-1 register + HSN summary, document-series gap report (INV-6), cancellations/reprints daily summary (INV-5), HUID register, ageing/dead stock, profit by item.
- Export: XLSX with Indian-grouping number format, CSV, PDF (server-side). Large reports run async with a "ready" notification.

### 1.7 Legacy features deliberately NOT carried over
Hidden backup billing/stock mode and truncate (D2); "Powered by ATTS"/AuSales branding (D1); hard-coded CGST/SGST 1.5% and "Tamil Nadu" on prints; hard-coded menu in `app_constants.js` (menu now comes from permissions + entitlements); in-app spreadsheet viewer (replace with export + table views); `aupay.auss.co` chit link.

---

## 2. Route map (TanStack Router, file-based, typed search params)

Host decides the *surface*: tenant host → tenant app; partner host → partner portal; platform admin host → console. Routes below are for the tenant app. Every authenticated route has `beforeLoad` guards for **session → permission → plan entitlement → feature flag**, and `loader`s that prefetch through Query.

```
/                         → redirect to /dashboard or /counter by role
/login  /login/otp  /login/mfa  /forgot-password  /reset-password/$token
/signup  /onboarding/$step

/_app (layout: top bar w/ branch+counter switcher, rate ticker, online/offline pill, sidebar, ⌘K)
  /dashboard
  /counter                      counter mode workspace (full-screen, keyboard-first)
    /counter/estimate/new   /counter/estimate/$estimateId
    /counter/bill/new?fromEstimates=…   /counter/bill/$invoiceId
    /counter/pending            offline queue
  /sales/invoices   /sales/invoices/$id   /sales/invoices/$id/cancel
  /sales/estimates  /sales/credit-notes  /sales/credit-notes/$id  /sales/misc
  /sales/receivables            (credit/debit)
  /inventory/lots  /inventory/lots/$lotId  /inventory/lots/$lotId/tag
  /inventory/tags?q=  /inventory/tags/$tagNo  /inventory/tags/bulk-update
  /inventory/stock  /inventory/ledger  /inventory/transfers  /inventory/transfers/$id
  /inventory/stock-take  /inventory/box-check
  /rates/metal  /rates/old-metal  /rates/carat
  /masters/{metals,tax,items,sub-items,standards,tag-types,range-stock,repair-types,
            value-addition/customer,value-addition/designer,customers,customer-groups,
            parties,cash-counters,floors,boxes}  (+ /$id for detail/edit)
  /orders  /orders/$id  /orders/board
  /repairs  /repairs/$id
  /purchases  /purchases/$id  /purchases/old-metal  /purchases/vendor-payments
  /purchases/vendor-discounts  /purchases/vendor-ledger
  /refinery/bags  /refinery/melting  /refinery/purification  /refinery/reconciliation
  /accounts/groups  /accounts/advances  /accounts/suspense  /accounts/vouchers
  /accounts/day-book  /accounts/statements/{trial-balance,pl,balance-sheet}  /accounts/gst
  /hr/staff  /hr/incentives  /hr/targets
  /approvals (inbox)  /approvals/rules  /approvals/requisitions  /approvals/requisitions/$id
  /reports  /reports/$reportKey?filters…
  /audit
  /settings/{general,organisation,company,users,roles,branding,domains,templates,
             templates/$kind/$version,senders,printers,import,export,subscription,devices}
/offline  /licence-expired  /maintenance  (catch-all) 404
```
Partner portal: `/partner/{tenants,tenants/$id,branding,domains,templates,billing,support-sessions}`. Platform console: `/platform/{tenants,partners,plans,health,support}`.

Search params (filters, pagination, sort) are Zod-validated so report and list URLs are shareable and restorable.

---

## 3. Design-token architecture and tenant theme loading

### 3.1 Token layers (`packages/design-tokens`)
1. **Primitive / brand tokens** (what a tenant edits, matches `branding.colors` and `fonts` JSONB in `015_branding.sql`): `primary`, `accent`, `surface`, `text`, `success`, `warning`, `danger` (+ dark variants), `radius`, `density`, `font.heading`, `font.body`, `font.indic`.
2. **Semantic tokens** (generated, never edited directly): `--background`, `--foreground`, `--card`, `--muted`, `--border`, `--ring`, `--primary`, `--primary-foreground`, `--destructive` … (the shadcn/ui contract), plus app-specific: `--metal-gold`, `--metal-silver`, `--metal-platinum`, `--status-sold`, `--status-on-approval`, `--offline`, `--rate-up/down`, `--chart-1..6`.
3. **Mode tokens**: `[data-density="counter"]` (larger touch targets, 16–18 px base, bigger tap/row heights, for 1366×768 counters and tablets) vs `[data-density="office"]` (dense tables); `[data-theme="dark"]`; `[data-contrast="high"]`.

- Token schema is a **Zod schema**. The generator emits CSS variables in OKLCH/HSL channel form so Tailwind opacity modifiers work (`bg-primary/80`).
- **Foreground colours are derived automatically** (contrast against the background), and publishing is blocked below WCAG AA (§20.4). The same checker runs in the branding editor for a live warning.
- `tailwind.config` (in `packages/ui`) maps **only** to `var(--…)`. The default Tailwind colour palette is removed (`theme.colors` replaced, not extended) so `bg-blue-600` does not even compile; plus the ESLint/stylelint ban as a second layer.
- Brand text: `useBrand()` returns `{ appName, shortName, logos, support, legalFooter, showAttribution }`. i18n messages take `{appName}`.
- Icons: one neutral icon set (lucide) coloured by `currentColor`. Logos are images from the branding store, never inlined SVG in code.

### 3.2 Loading per host (no flash of platform branding)
1. Request hits Caddy → API renders `index.html` **per host** (title, `<meta name="theme-color">`, `<link rel="manifest" href="/manifest.webmanifest?v=…">`, `<link rel="stylesheet" href="/branding.css?v=<brandingVersion>">` preloaded, favicons).
2. The SPA bundle is identical for everyone. It reads an inline `window.__BRAND__` bootstrap JSON (app name, version, locale defaults, surface = tenant/partner/platform) for `useBrand()`.
3. `/branding.css` is the resolved profile (tenant → partner → platform default, field by field) as `:root{…}` + `[data-theme=dark]{…}` + `@font-face` (locally hosted Noto Sans / Noto Sans Tamil / Devanagari always kept as fallbacks).
4. **Offline:** the service worker caches `index.html`, `branding.css`, manifest and icons with *stale-while-revalidate keyed on brandingVersion*. When online, the app polls (or reads an SSE/header `X-Branding-Version`) and swaps the stylesheet without reload when a new version is published.
5. **Branding editor preview:** applies the draft token set to a scoped container (`<div style={draftVars}>`) so the admin previews without affecting the live app; plus a side-by-side "sample invoice" preview from the template service.
6. **On-prem/dedicated full rebrand:** the brand pack is installed into the instance's Platform module, so the same mechanism serves it.
7. **Visual regression:** Playwright screenshots of key screens under three sample brands (light, dark-primary, high-contrast) from `packages/test-utils`. Part of review gate G4 for UI changes.

---

## 4. Offline / PWA strategy

Two realities: **on-prem** (server on LAN; offline from the internet is normal and the app behaves as online) and **cloud** (internet loss at the counter).

| Layer | Strategy |
|---|---|
| App shell (JS/CSS/fonts/index per host) | Workbox precache via vite-plugin-pwa; `registerType: 'prompt'` with an "Update available" toast (never auto-reload mid-bill). |
| Branding assets | Runtime cache, SWR, versioned URLs. |
| API GET | TanStack Query with `persistQueryClient` to IndexedDB for whitelisted queries only (masters, rates, settings, permissions). `networkMode: 'offlineFirst'` for those. |
| Offline data store (Dexie) | Tables: `items`, `subItems`, `purities`, `taxRules`, `valueAddition`, `customers` (recent/branch subset, PII-minimised), `rates` (today + effective-dated), `tagSnapshot` (in-stock tags for the branch: tagNo, HUID, weights, stones, min/max, status), `estimatesDraft`, `pendingIssue`, `syncMeta`. Snapshot refreshed by delta (`?since=` cursor) every few minutes and on focus. Per-tenant DB name; wiped on logout/tenant switch. |
| Offline capabilities (cloud) | Tag lookup, prepare/print **estimates** (local estimate ref, not a tax number), customer quick-add (queued), view today's rates. |
| Offline bills | Saved as **"Pending issue"** (clear watermark "NOT A TAX INVOICE — pending"). On reconnect, the queue replays to the single `issueInvoice` endpoint with an **idempotency key** (UUIDv7 generated on the device). Server may reject (tag sold elsewhere, rate changed, price below min) → item goes to a conflict list for the cashier to resolve. **No device-side numbering ever.** |
| Mutations generally | Online-only except the whitelisted queue above; buttons disabled with a reason when offline. |
| Connectivity UX | Persistent online/offline pill in the top bar, queue count, last-sync time. Heartbeat to `/api/health` rather than trusting `navigator.onLine`. |
| Security | No PAN/KYC numbers or cost price cached offline. Dexie cleared on logout. Session expiry while offline: allow the read-only offline features only until a re-auth. |
| HTTPS | Required; on-prem uses the DNS-01 LAN hostname (§3.2 of architecture). |
| Print offline | Estimates print via the browser using the cached template version; thermal via the local print-agent (localhost). |

Open item: rate staleness rule offline (block estimates if today's rate is not cached? warn only?). See questions.

---

## 5. i18n and number/currency formatting

- **Library:** FormatJS / react-intl, ICU messages. Catalogues in `packages/i18n/messages/{en-IN,ta-IN,hi-IN,te-IN,kn-IN,ml-IN}.json`, namespaced per module (`sales.*`, `inventory.*`). Tamil (`ta-IN`) is the first non-English locale and blocks release in Phase 1; others ship later.
- Extraction: `formatjs extract` in CI; missing-key check per locale; lint rule bans literal JSX text. Pseudo-locale (`en-XA`, long strings) in visual tests to catch truncation; Tamil strings run ~30–40% longer, so layouts use flexible widths.
- Locale per user (fallback: tenant default → `en-IN`). Lazy-load catalogues per locale. Fonts: Noto Sans Tamil / Devanagari self-hosted, `font-display: swap`, subset.
- **Formatting wrappers** in `packages/i18n/format` (one place; ESLint bans raw `toFixed`/`toLocaleString`):
  - `formatINR(decimal)` → `Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'})` → `₹1,23,45,678.50`. Digits are always Latin with en-IN grouping, even in Tamil UI (to confirm, see Q).
  - `formatCompactINR` → `₹1.23 Cr`, `₹12.4 L` for dashboards.
  - `formatWeight(g)` → `12.345 g` (3 dp, fixed). `formatPurity` → `22K 916`. `formatPercent`.
  - Dates `dd-MM-yyyy`, time zone fixed to `Asia/Kolkata`; financial-year helper (Apr–Mar).
  - Amount in words (English/Tamil/Hindi) comes from `packages/domain`, shared with print templates.
- **Inputs:** `<MoneyInput>`, `<WeightInput>`, `<PurityInput>` accept typed values, show lakh grouping on blur, store **strings** fed to decimal.js (never JS numbers). Validators for GSTIN, PAN, IFSC, PIN, Indian mobile from `packages/domain`.
- Excel export uses an Indian-grouping custom format (`[>=10000000]##\,##\,##\,##0.00;[>=100000]##\,##\,##0.00;##,##0.00`), tested in Excel and LibreOffice.
- Server error codes map to message keys (typed error catalogue), so API errors are localised too.

---

## 6. OpenAPI client generation

- **Source of truth:** `packages/contracts/openapi/*.yaml` (OpenAPI 3.1, split per module, `/api/v1/<module>/…`). Spectral lint + oasdiff in CI (owned by backend/architect).
- **Generator: Orval** → into `packages/contracts/generated/` (committed or built; CI fails on drift):
  - TypeScript types for every schema;
  - **Zod schemas** (request + response) for runtime validation at the boundary and reused by React Hook Form resolvers;
  - **TanStack Query hooks** per operation (`useGetTag`, `useIssueInvoice`) + query-key factories;
  - MSW handlers + faker mocks for Storybook/tests and for building UI before the backend exists.
- **Custom mutator** (`apps/web/src/lib/api/fetcher.ts`): `fetch` with `credentials:'include'`, CSRF header, `Accept-Language`, `X-Branch-Id`, `Idempotency-Key` for POST of documents, problem+json error parsing → typed `ApiError` with code, 401 → session-expired flow, 402/403-entitlement → upgrade prompt, 409 → conflict UI.
- **Decimals in the contract:** money/weight as `string` with `format: decimal` (pattern-validated), converted to `Decimal` in the UI layer. Needs agreement with backend (Q).
- **Permissions & entitlements** as enums in the contract → generated `Permission` union type used by route guards and `<Can perm="sales.invoice.cancel">`.
- Version skew (on-prem): the client reads `/api/meta` (`apiVersion`, `minClientVersion`) and forces a shell update when incompatible.
- No hand-written fetch code anywhere (lint rule bans `fetch`/`axios` outside the mutator).

---

## 7. Folder structure (within the monorepo from architecture §4)

```
apps/web/
  index.html                 template placeholders filled per host by the API
  vite.config.ts             vite-plugin-pwa, TanStack Router plugin
  src/
    main.tsx  app.tsx        providers: Query, Router, Intl, Brand, Theme, Session, Offline
    routes/                  file-based TanStack routes (mirror §2)
    features/                one folder per functional module (D12), mirroring backend
      platform/ (auth, onboarding, users, roles, settings, branding, domains, templates, import, audit)
      masters/  rates/  inventory/  sales/  orders-repairs/  purchases/  refinery/
      accounts/  hr-incentives/  approvals/  reports/  notifications/  saas-billing/
        each: components/ hooks/ forms/ (Zod) columns/ (Table defs) index.ts (public API)
    counter/                 counter-mode workspace: bill engine UI, scan input, payments panel,
                             keyboard map, pending-issue queue
    shell/                   layout, top bar, sidebar (permission+entitlement driven), ⌘K, offline pill
    lib/
      api/                   fetcher (Orval mutator), error mapping, idempotency
      offline/               Dexie schema, sync workers, queue replay
      auth/                  session, guards, <Can/>
      brand/                 useBrand(), branding version watcher
      print/                 template preview, print-agent client (localhost pairing)
      devices/               scanner (keyboard-wedge + camera), scale stream
    test/                    Playwright e2e, visual-regression brands
packages/
  ui/                        shadcn-based components, DataTable (TanStack Table + virtualisation),
                             MoneyInput/WeightInput, Tailwind preset → CSS vars only
  design-tokens/             Zod schema, defaults, CSS generator, contrast checker, sample brands
  i18n/                      catalogues + formatters
  contracts/                 OpenAPI + generated client
  domain/                    pricing/GST preview, validators, amount-in-words (shared w/ backend)
  config/                    flag registry, entitlements
```
Boundary rules (dependency-cruiser): `features/x` imports only `features/y/index.ts`; nothing in `apps/web` imports `generated/` except via feature hooks; `packages/ui` cannot import `contracts`.

---

## 8. Cross-cutting UX design direction (fresh look, D5)

- Two modes: **Counter** (full-screen, scan box always focused, large type, F-key/Ctrl shortcuts kept from legacy *intent*: toggle GST, open payment, save, back; but re-mapped without conflicts) and **Office** (dense, sidebar, data tables with column chooser, saved views, sticky totals).
- Bill screen layout: left = line items from scans; right = live totals panel (gross, old-gold deduction, returns, advances, GST breakup, round-off, payable), bottom = split-payment drawer. Every money number via formatters.
- Tables: TanStack Table + virtualisation, server-side pagination/sort/filter for big lists; totals row in ₹ and grams.
- Accessibility: Radix primitives, visible focus rings from `--ring`, keyboard-complete flows, WCAG AA enforced by tokens.
- Mobile/tablet: owner dashboard, approvals inbox, tag lookup with camera scanner are fully responsive; full billing targets ≥1366×768 and tablets in landscape.

---

## 9. Phased build order

**F0 — Foundations (with backend Phase 0, ~3–4 weeks)**
1. `apps/web` skeleton, strict TS, ESLint bans (colours, brand strings, literal JSX text, raw fetch, `parseFloat` on money), dependency-cruiser.
2. `design-tokens` + Tailwind preset + shadcn base components; three sample brands; Storybook + visual regression.
3. `i18n` with en-IN + ta-IN pseudo coverage; formatters + inputs with unit tests.
4. Orval pipeline against a first contract slice (auth, branding, meta) with MSW mocks.
5. Per-host `index.html`/`branding.css` contract with backend; `useBrand()`; branded error/offline pages.
6. PWA shell (precache, update prompt), connectivity detector.

**F1 — MVP single branch (backend Phase 1, ~3–4 months), in this order**
1. Auth (password, OTP, MFA), session, guards, shell, permissions-driven nav, branch/counter switcher.
2. Signup + **shop setup wizard (§9.1)**; settings: company, branches, users, roles matrix.
3. Masters & rates (metals/purities, rates + ticker, tax, items/sub-items, standards, tag types, customer value addition, customers, parties, cash counters).
4. Inventory: lots → tagging (HUID) → tag lookup/update/duplicate → stock list/ledger; print-agent pairing + label print.
5. **Counter workspace**: estimate → bill (one engine), old gold, sales return, advances, split payments, guardrails; invoice view/reprint; cancel → credit note.
6. Offline: Dexie snapshot, offline estimates, pending-issue queue + conflict resolution.
7. Report runner + Phase-1 reports, GSTR-1 register/HSN export, series-gap report, audit viewer, alerts centre.
8. Branding editor, template manager (preview/lint), import (dry-run), export, subscription page.
9. P1: dashboard, receivables, standalone old purchase, e-bill send, custom domains, senders. Tamil catalogue complete.


### 9.1 F1 item: Shop setup wizard (approved 20 Oct 2026)
Route `/setup` (stubbed in F0; replaces the "signup + onboarding wizard" line in §1.1 and F1 step 2).

| # | Step | Skippable | Gates "Start billing" |
|---|---|---|---|
| 1 | Shop profile (legal/trade name, address, state, contacts, logo) | **No** | Yes |
| 2 | GST (shop GSTIN verify, registration type, place of business) | **No** | Yes |
| 3 | Branches. **Branch GSTIN is optional and defaults to the shop GSTIN; it is required only when the branch is in a different state from the shop GSTIN.** | Yes | No |
| 4 | Metals & purities (seeded: 24K 999, 22K 916, 18K 750, silver 925…; edit/disable) | Yes | Yes |
| 5 | GST rates (seeded metal/HSN tax rules; effective-dated) | Yes | Yes |
| 6 | Today's rates (sale + old-metal per purity) | Yes | Yes |
| 7 | Users & roles (invite staff, role templates) | Yes | No |
| 8 | Branding (logo, colours via token editor with contrast check, app name) | Yes | No |
| 9 | Printers & layout (print-agent pairing, invoice/estimate/label template + format) | Yes | No |
| 10 | Data import: **generic CSV/Excel templates** (customers, vendors, items, opening tagged stock, opening balances) with **dry-run** → error table → commit | Yes | No |

Behaviour:
- **Resumable:** progress is server-side per tenant (step status `todo | done | skipped`), so a user can leave and continue on any device; the wizard opens at the first incomplete step.
- **Skippable** except steps 1–2. Skipped steps stay listed as a checklist on the dashboard and in Settings.
- **"Start billing"** is enabled only when steps 1, 2, 4, 5 and 6 are `done` (seeded defaults count once confirmed). The same gate is enforced on the server for invoice issue; the UI only reflects it.
- Each step reuses the real Settings/Masters form for that entity (no duplicate wizard-only forms).
- Validation: GSTIN/PIN/mobile validators from `domain`; branch state vs shop GSTIN state decides whether branch GSTIN is required.
- Import uses the async import job API: upload → dry-run report (row errors, counts) → confirm. Templates are downloadable per entity, en-IN number formats.
- F0 stub constants: `SETUP_REQUIRED = {1,2}`, `START_BILLING_GATE = {1,2,4,5,6}` in `src/routes/setup.tsx`.

**F2 — Chains & workshops (~3 months):** partner portal; multi-branch views & transfers; floors/counters/boxes/box check; purchases & vendor settlement; orders (+Kanban) & repairs; approvals inbox/rules/requisitions; incentives & targets; e-invoice status; platform console.

**F3 — Depth:** accounting screens, refinery, chit scheme, loyalty, stock-take/RFID, more Indian languages, owner mobile polish, analytics.

Each step is cut into ≤1-day, ≤400-line vertical slices per architecture §14 (spec → contract → failing tests → code), with Playwright e2e on the critical path: rate → tag → estimate → bill → cancel → credit note → report, plus offline estimate.

---

## 10. Missing inputs and open questions

**Missing files / inputs**
- **No OpenAPI contract exists yet** (`packages/contracts` not present). Frontend can start against MSW mocks, but the client cannot be generated for real.
- No brand name, logo or sample brand assets (spec Q1 / arch Q7). Sample brands must be invented for visual tests.
- No print-template samples from pilot shops; no list of label/thermal printer or scale models.
- No golden bills (needed for preview-vs-server parity tests of the pricing engine).
- Legacy `src/assets/data/menu.json` is empty (0 bytes); menu exists only in `app_constants.js`.
- No wireframes or design references for the "fresh look"; this plan defines direction only.

**Questions for Adithya**
1. **Brand & default theme:** what is the platform brand name and default palette/logo (needed for platform-default tokens, sample brands, domains)?
2. **Offline scope in cloud mode:** is "pending-issue" bill capture offline acceptable (customer leaves with an estimate/receipt and gets the tax invoice later via WhatsApp), or should offline stop at estimates only? And should estimates be blocked when today's rate is not cached?
3. **Tamil scope for MVP:** Tamil UI only, or also Tamil on printed invoices and amount-in-words? Latin digits in Tamil UI (recommended) or Tamil numerals anywhere?
4. Should the platform admin console and partner portal be modes of the same web app (recommended, host-based) or separate apps?
5. Contract convention: money/weight as decimal **strings** in JSON (recommended) — backend agreement needed.
6. Minimum supported devices/browsers at counters (Windows 7/old Chrome? Android tablets? iPad?), which affects PWA and Web Serial choices.
7. Which legacy keyboard shortcuts do cashiers actually rely on (to keep muscle memory)?
8. Can partners customise fonts with uploaded WOFF2, or only from the curated list for MVP?

---

## 11. F0 status (built 20 Oct 2026, local only)
Built under `/workspace/frontend` as a single Vite app (to be moved into `apps/web` + `packages/*` once the monorepo exists): design tokens (`src/design-tokens`), formatters (`src/lib/format`), i18n en-IN + ta-IN (`src/i18n`), Orval client from a **frontend-written draft contract** (`contracts/openapi.draft.yaml`, NOT authoritative), MSW mocks shaped on schema v1, Dexie pending-bill queue, PWA (vite-plugin-pwa, prompt update), TanStack Router/Query, shadcn-style UI, lint guards. See `README.md`.

## 12. Rework addendum (F0 rework + Platform screens, local only, not committed)
This section replaces any conflicting text in §4, §5, §9.1 and §11.

- **§4 Offline (replaces the old pending-bill queue).** Billing and estimates work only online. When offline, the app shows a translated banner and disables the bill and estimate buttons. Nothing is queued and the client never assigns a document number. The PWA uses Workbox NetworkFirst on `GET /api/v1/*` (except `auth/*` and `platform/meta`), so screens already opened stay readable and read-only. Online status comes from a heartbeat on `/platform/meta`.
- **§5 Language.** The tenant sets a default language, and each user can override it with `locale_override` ("Follow shop" or a specific language). Each print picks its own language (en-IN, ta-IN or bilingual) and numerals (Western or Tamil). Amounts in words go through `amountWithWords`. All formatting is en-IN (₹, lakh grouping).
- **§9.1 Import.** Mapping profiles are pluggable (`features/import/profiles.ts`: generic profile, auto-detection, CSV/XLSX parsing, then a server-side dry run and commit). There is no importer specific to one vendor (such as AuSales). Each new source is a profile entry. XLSX is currently parsed in the browser.
- **GST rates.** `/settings/gst-rates` redirects to `/settings/tax`.
- **Contracts.** Most Platform endpoints exist only in `contracts/platform-ext.draft.yaml`. They are served by MSW in dev and still need backend sign-off.
- **§11 Status.** lint, tsc, vitest (81 tests) and build are green. The smoke script (`scripts/smoke.mjs`) writes screenshots to `screenshots/f0` and `screenshots/platform`.
- **Not built, by request:** custom roles, SMS sender IDs, data export.

## 13. Masters design (M1–M8, M10–M15, M17; M9 and M16 later)

**Nav:** a Masters section with home cards grouped as Products (items, designs, stone types, stone rates, HSN, making charge & wastage), People (customers, suppliers/karigars, staff), Shop layout (floors, counters, trays), Money (payment modes, bank accounts, card machines), and Import & export.

**One pattern:** `features/masters/registry.ts` declares each kind's fields (type, ref, required, basic/advanced, hint, pattern). `MasterScreen` gives every kind the same search, In use / All filter, ref filters, a cursor-paged table with "Show more", and a drawer form.
- Basic forms have 5 fields or fewer. Everything else sits in a collapsed "More details (optional)" section, and any required advanced field has a default.
- The code is suggested from the name.
- There is no delete: "Stop using" sends a PATCH of `is_active` with If-Match. A 412 asks the user to reload; 409 and 422 errors are mapped onto the matching fields.
- Money and weight are decimal strings only (decimal.js), shown in en-IN format.

**Designs:** the same pattern plus a photos panel (JPEG/PNG/WebP, 5 MB each, max 8). Uploads go one by one with If-Match. The first photo is the cover.

**Customers:** PAN is a masked write-only field; lists and the drawer only ever show `••••••234F` (`pan_last4`). No Aadhaar anywhere (owner decision). KYC types are PAN, passport, voter ID, driving licence, GST certificate and other (`KYC_TYPES`). Pickers for other masters use type-ahead (`q`, 20 at a time); metals, purities, branches and bank accounts load whole. Every create sends an Idempotency-Key, which is kept across a retry and reset when the form changes.

**Import/export (M17):** reuses the P21 importer (dry run → mapping profiles → commit) limited to master kinds, plus an Export card (`createExport` csv/xlsx with an "include stopped rows" option → signed file URL). The export never includes a full PAN.

**Gaps:** see `MASTERS_API_ASSUMPTIONS.md`. When an endpoint isn't live (404), the screen shows a plain note instead of an error.

### §13 update — contract 0.7.0
Masters perms are per area (`masters.<area>.manage` / `.view`). Photos use the files API with move/cover controls. The audited KYC reveal lives on the customer, vendor and staff drawers (transient state only). Sub-items and KYC documents are added to the registry, and vendors show a PAN backfill notice. See MASTERS_API_ASSUMPTIONS.md (0.7.0).

- 28 Oct 2026: masters adapted to contract 0.7.1 (perms/roles from seeds, ids batch labels, 422 code messages, strict sub-items, Indian mobile check, schema realignment). Open items G16–G20 in MASTERS_API_ASSUMPTIONS.md.
- 28 Oct 2026: Rates screens (entry with fineness derivation, branch override, history filters, printable rate card, today's-rate banner) built on 0.7.1 + mocks behind features/rates/api.ts. Assumptions R1–R5 in MASTERS_API_ASSUMPTIONS.md. 0.7.2 not adapted (awaiting 0.7.3).
- 28 Oct 2026: contract 0.7.3 (e566c2a) adapted: G16/G17/G18/G20 closed, floors import/export, card-machine active cash counters + inactive_master field error, vendor pan_not_migrated. Open: C1–C4 in MASTERS_API_ASSUMPTIONS.md.

### 0.7.4 rates wiring (done 28-10-2026)
Rates go through features/rates/api.ts on the generated client (todaysStatus, rateCard, publishBatch, history with metal_id). Mocks mirror the batch/derive/correction rules. C2 till id is a plain field.

## 14. Inventory (contract 0.8.9) + password screens (5 Nov 2026)

Phase 1 (placeholder API) was replaced the same day by contract 0.8.0 (backend `d38a20f`), 0.8.2 (`314854a`) and then
contract 0.8.3 (`e377df2`) and now **contract 0.8.4** (backend commit `971e252`, copied to `contracts/backend.openapi.yaml`,
sha256 `bc4f6a57…a5a69c217b565`, Orval 7.13.2 (lock pin) regenerated with `npm run api:generate`). See `INVENTORY_API_ASSUMPTIONS.md` for every closed assumption and the open
gaps. `features/inventory/api.ts` wraps the generated functions (keys under `['inventory', …]`); `types.ts` re-exports
generated models. 0.8.9 (`83c1490`, sha256 `fad01141…`): stricter required fields; piece details shows labels printed + last printed time;
report rows with an unknown status show "—"; a label print refreshes cached pieces. 0.8.8 (`34cb7f4`, sha256 `e69c5bfa…`): response shapes only — labels repeat per row `copies` with a Duplicate
mark, close reads `created_adjustment_ids`, report rows `status`, transfer rows carry `lines`. 0.8.7 (`591ba50`, sha256 `fd36687c…`): tag reads carry making charge, wastage, barcode payload and tray; reprint
reason 3–200 enforced; 409 `already_printed` (server gap) opens the reprint reason like 422 `reprint_required`. 0.8.6 (`a9c8311`, sha256 `efff8489…`): every StockCheck response carries counts; the stock-check screen still reads
them null-safe and GETs the check after start. 0.8.5 (`fc69467`, sha256 `959dd477…`): GET /tags with no status hides sold / melted / returned / written-off;
the stock list's "Any status" sends every status explicitly. 0.8.4 runs on the VPS test DB only (not deployed); every operation is built. The per-page "not switched on yet" note is
gone; `isNotReady` / `NotReadyOr` remain the generic 404/501 guard. 0.8.4: PATCH deletes left-out lines — the lot and
draft-transfer editors confirm removals first; lot lines with tagged pieces are locked (409 `line_tagged` → plain text).

**0.8.2 house rules:** If-Match from the row `version` on every edit and decision (tag status, transfer approve /
dispatch / receive / return / cancel, stock-check close / cancel, adjustment decisions, photos, settings); dispatch,
receive, every create and label print also send an Idempotency-Key. Every reason / note is trimmed and ≥ 3 characters
(`MIN_TEXT`), optional notes are empty or ≥ 3; the forms check this before sending. `FEATURE_INVENTORY_PERMS` is **on** (16 codes + `transfer.approve`, `tag.view_cost`).

**Routes:**

| Route | Contents | Permission |
|-------|----------|------------|
| `/inventory` | Stock list (status filter: In stock default / Active = server default / Any status = all named, incl. terminal; selection → labels) | stock.view |
| `/inventory` (top) | Stock summary card (GET /stock-summary, group by status, loose included) | stock.view |
| `/inventory/pieces/$id` | Tag detail, supplier lot ref (view / PATCH), history with from → to and status before → after (load more), status change (reason ≥ 3, If-Match), photos: GET list → `/v1/files/{id}/url` thumbnails, make main (PATCH, If-Match), add / remove (≤10) | stock.view (API) |
| `/inventory/tag` | One form: common fields + supplier lot ref + rows; 1 row → createTag, n → bulk (≤200). `?lot=&line=` tags from a lot line (source `lot`, branch / item / purity locked) | tag.create |
| `/inventory/lots?id=` | Lots: list (branch / status / search), create (Idempotency-Key), detail with per-line progress, edit while open or tagged (If-Match; remove untagged lines after a confirm, tagged lines locked), close (If-Match; remainder none / to loose stock), "tag from this line" | stock.view (edit: tag.create) |
| `/inventory/labels?ids=` | POST labels (records the print, Idempotency-Key; no reprint_reason on a first print), reprint with reason 3–200 (422 reprint_required or 409 already_printed opens it), Code128 SVG; QR templates draw a real QR (`qrcode-generator@2.0.4`, SVG path, quiet zone 4) | tag.print_label |
| `/inventory/loose` | Loose balances + receipts | stock.view / tag.create |
| `/inventory/transfers` | Draft → edit (remarks, add / take off pieces with a confirm; PATCH If-Match) → approve → dispatch → receive (partial) / return / cancel | stock.view + dispatch/approve/receive |
| `/inventory/moves` | Counter/tray moves + recent moves list (GET /moves, counter filter, load more) | move |
| `/inventory/stock-check` | Start (run), one POST per scan, scanned list from GET …/scans with the server outcome (found / not expected + why), last-scan line, undo, report (GET …/report page: tabs with counts, labels, status, load more; also after close), close (+ pending full write-offs) / cancel (close, If-Match) | stock_check.run / .close |
| `/inventory/adjustments` | Request (tag or loose; partial `write_off`, whole-piece `full_write_off`), approve/reject (note ≥ 3)/withdraw | stock.view + adjustment.request/approve |
| `/inventory/valuation` | Server valuation, group by purity/metal/branch/counter/item; footer from `value_basis` + `includes` | valuation.view |
| `/inventory/opening` | Opening stock (Importer) | platform.import.run |
| `/inventory/ageing` | Server ageing buckets (age from received_on, else tagged date) + per-group table | ageing.view |
| `/settings/inventory` | Structured tag format + server preview, transfer / adjustment number formats, photos, ageing edges, approver | stock.view (edit: settings.edit) |

**Pure logic** (unit tested in `inventory.test.ts`):

| File | What it does |
|------|--------------|
| `tag-format.ts` | Structured render, scope key, validate, new-series check, PATCH diff |
| `ageing.ts` | Edge parsing/validation, server bucket labels |
| `adjustments.ts` | `MIN_TEXT`/`textOk`/`optionalTextOk`, kind shapes, signed weights, full write-off deltas, form errors, `canApprove` |
| `doc-no-format.ts` | Transfer / adjustment number format validation (`{SEQ}` once, last), sample render, Indian FY code |
| `piece-rules.ts` | Tagging validation, bulk row mapping, bulk 422 row errors |
| `barcode.ts` | Code128-B encoder (patterns, checksum, bars) |
| `qr.ts` | QR matrix (`qrcode-generator`, byte mode, level M, UTF-8), SVG path |
| `lots.ts` | Lot line drafts / checks / PATCH lines, removed-line detection, `canRemoveLotLine`, `lotIsOpen`, progress, supplier lot ref, draft-transfer PATCH lines |

Removed: `valuation.ts` (client valuation maths) and `scan.ts` (client reconcile), with their tests.

**Passwords (real 0.7.4):**

- `/account/password` (key icon in the header) uses `POST /v1/auth/password`. A 401 `invalid_credentials` shows inline next to the current password; it does not sign the user out. Other sessions are revoked by the server.
- Settings > Users has a "Reset password" drawer that uses `PUT /v1/users/{id}/password`. It is hidden on your own row, because an admin resets their own password through Change my password.
- Rules (`features/auth/password-rules.ts`): 8–128 characters; the new password must match its confirmation and must differ from the current one.

All strings are in en-IN and ta-IN. The UI uses tokens only. One package added: `qrcode-generator` 2.0.4 (exact pin, MIT, no dependencies; approved by Adithya 5 Nov 2026 11:20 AM IST).

## 15. Sales / billing (contract 0.9.2, 10 Nov 2026)

Contract **0.9.1** (backend `1ff86a5`, sha256 `9c2687d29e3f5f8ae97f80bce7c96b85c31841d11e372e7d32db742c5c89825e`) pinned to
`contracts/backend.openapi.yaml` and regenerated (`npm run api:generate`, Orval 7.13.2, `fixSpec` transformer for the duplicate CreditNoteRefundMode
enum). Sales routes are contract-only on dev (404) → every Sales screen shows "Billing isn't switched on yet"; tests use stubbed fetch only.
Inventory parts of 0.9.x: UTC timestamps shown in IST (`parseInstant`), summary "{tags} tags · {pieces} pieces" from `tag_count`, Pcs column.
Dev mocks are gated by `import.meta.env.DEV && VITE_API_MOCKS === 'true'` (main.tsx) so msw never reaches a production build.

**Gate:** `FEATURE_SALES` (features/flags.ts) + permissions (`SALES` codes; `SALES_ROUTE_PERMS`, `SALES_NAV_PERMS`); nav group "Billing".

| Route | Contents | Permission |
|-------|----------|------------|
| `/counter` | Hub tiles (new bill, new estimate, bills, estimates) + device / setup gates | — |
| `/counter/bill?estimates=a,b` | Counter bill: scan (`/sellable`), server-priced lines with tax parts, customer search / quick add (409 → "Use this customer"), salesperson (remembered), old gold (+ 0.9.1 rate override pair), discount, zero GST, debounced preview → totals + GST breakup + big amount to pay, PAN (write-only, when required), split / part payments, blocking reasons (credit sale, cash limit, PAN, …), Issue with expected_total (mismatch → confirm new total), save as estimate. Keys F1–F4, F6, Ctrl+S, Ctrl+E | sales.invoice.issue |
| `/counter/estimate?id=` | Same screen in estimate mode (create / PUT with If-Match) | sales.estimate.create |
| `/sales/invoices` | Bill list with filters, cursor paging | sales.invoice.view |
| `/sales/invoices/$id` | Bill detail, receipts, pay balance, print (original / duplicate with reason), return lines, cancel | sales.invoice.view |
| `/sales/estimates`, `/$id` | List, merge ≤ 10 → bill, detail (convert, change, cancel, print) | sales.estimate.create |
| `/sales/credit-notes`, `/$id` | List and detail with print | sales.invoice.view |

**Files:** `features/sales/` — `api.ts` (wrappers + keys + `isSalesOff`), `logic.ts` (pure rules, unit tested), `ui.tsx`, `bill-page.tsx`,
`customer.tsx`, `old-gold.tsx`, `tenders.tsx`, `totals.tsx`, `print.tsx` (+ named `@page` rules in `index.css`), `invoice-page.tsx`, `lists.tsx`,
`hooks.ts`, `fixtures.ts` (tests). Tests: `sales.test.ts`, `sales-ui.test.tsx`. Per-shop values (cash limit + mode, PAN threshold, discount %, estimate validity,
paper, print language, return window, refund default, old-gold excess handling) are read from `GET /v1/sales/settings`, never hard-coded.

**Milestone 2 (9 Nov 2026):** `loose.tsx` — untagged (loose) line entry on the bill and estimate (item, purity, pieces, gross / stone / net wt,
counter + tray of the bill's branch; checked before adding; 409 `insufficient_loose_stock` points at the line). Restock picker (counter → tray) on
return and cancel; `restock` is sent only when a counter is picked (server default = where each piece was sold from). Per-line discount column
(only with `sales.discount.give`); above `discount_max_pct` needs `sales.price.override_min` + a reason, above `large_discount_pct` is a warning.
B2B: the customer's GSTIN makes the bill B2B and fixes place of supply to the GSTIN state (shown locked); B2C may set another state code. Dev
mocks: `mocks/sales.ts` prices preview / sellable and serves seeded bills, estimates, credit notes, prints and the stock summary (dev server only).


**0.9.2 update:** `/sales/settings` (owner; sales.settings.edit) replaces the old sales-policy form, including the setup wizard / tax-page read.
The PATCH sends only writable changes with If-Match version (0 for defaults); a 412 preserves input until reload, and the full saved response
replaces cached settings. Readiness / making-service-rate refusal links use the mapped settings_path. Preview sends mode=estimate without
customer / salesperson; invoice-only checks are informational. All details show print count + last print in IST; every duplicate needs a reason.
Receipt reversal (sales.receipt.reverse, reason + confirmation + idempotency) restores balance and displays the new store-credit note.
`events.ts` maps receipt_reversal and alert.receipt_reversal to Payment reversed, uses store credit given back as its amount, and excludes the kind
from GST/CDN consumers. Zero-piece loose lines remain valid on estimates but block invoice issue with an editable count on the marked line.
Named RefundMode, ReturnRefundMode and shared policy enums now come directly from Orval; the transformer workaround is removed.
