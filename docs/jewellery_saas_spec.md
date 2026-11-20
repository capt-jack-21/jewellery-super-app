# Jewellery Retail SaaS — Product Specification and Feature List

**Owner:** Adithya Venkatesh A (Coimbatore, India)
**Document status:** Draft v0.6, 20 Oct 2026 (v0.2 recorded owner decisions D1–D2; v0.3 added D3–D10 on technology and deployment; v0.4 added D11 white-labelling and D12 the 14-module structure; v0.5 added D13–D28 from the master bot: retail-only scope, data model v0.2, money/rounding, auth, offline bills, document numbering, alerts, dev environment and bot team; v0.6 records the owner's overrides and accepted decisions D29–D37: no offline billing, language as a master setting, GST rates in settings, a 10-step onboarding wizard, outbox reference columns, per-line tax rounding, the single allowed invoice change, configurable INV-5 thresholds and the outbox → pg-boss relay. Details are in the companion *Architecture and Tech Stack* document, `jewellery_saas_architecture.docx`.)
**Source analysed:** existing React frontend `billing_frontend-main` (package name `ausales`, ~122k lines of JS/JSX, 96 page modules under `src/pages`, 411 API endpoint constants, 7 print templates). The repository contains **no backend**.

## How to read this document

- **[Exists]** means the code in `billing_frontend-main` has a screen or component for it. The screen is named by its route and its `src/pages/<folder>`. "Exists" means a **frontend screen exists and calls an API**. Because there is no backend, none of these features run end-to-end today.
- **[Partial]** means some fields or screens are there, but the feature is incomplete, hidden from the menu, or hard-coded.
- **[Suggested]** means the frontend has nothing for it. It is a recommendation for the SaaS product and needs the owner's decision.
- Indian regulatory points (GST, BIS hallmarking, PAN/cash limits, e-invoicing) are included as product requirements to **validate with a chartered accountant / compliance advisor**. They are not legal advice.

## Owner decisions (recorded 20 Oct 2026)

| # | Decision | Consequence for this spec |
|---|---|---|
| D1 | **Code ownership:** the owner wholly and exclusively owns the `billing_frontend-main` frontend code. There is no rights or licensing issue in reusing, modifying or commercialising it. | The "AuSales" / "Powered by ATTS · © 2024 ATTS PVT LMT" branding is treated as legacy branding to be **rebranded** (Phase 0 task). It is no longer an open question. |
| D2 | **Hidden backup billing mode is dropped.** The owner confirmed that this mode let customers buy without GST. It is removed permanently and will not exist in the SaaS in any form. | Removal is a concrete Phase 0 task (Section 9). Section 6.10 adds invoice-integrity requirements: a single gapless GST invoice series per branch per financial year, an immutable audit log, no deletion of bills (cancellation only via a credit note), and admin alerts on cancellations. |

### Decisions update (v0.3, 20 Oct 2026)

| # | Decision | Consequence for this spec |
|---|---|---|
| D3 | **Brand-new backend in Node.js** (TypeScript). No original backend exists. | Gap #1 is closed by building it, not by recovering it. The legacy `api_endpoints.js` is a feature inventory, not an API contract. |
| D4 | **PostgreSQL** is the database. | Tenant isolation via forced Row-Level Security; INV-1..INV-6 enforced in the database (architecture doc, Section 11). |
| D5 | **Completely redesigned frontend** with a fresh look, nothing like the old AuSales UI. The old React app is a **feature reference only**. | Section 5's "existing screens" now mean reference screens. No legacy UI code is ported by default. |
| D6 | **Three deployment modes from one codebase:** on-premise (shop's own server/PC, possibly poor internet), shared multi-tenant cloud, dedicated cloud instance per customer. | Adds on-prem licensing/activation, an update channel, local plus offsite backups and offline operation to the SaaS capabilities (architecture doc, Sections 5–7). |
| D7 | **Cloud-agnostic:** Docker; no proprietary managed services in the core; provider undecided. | Hosting choice stays open; the architecture doc compares candidates. |
| D8 | **Extremely low running costs.** | Modular monolith with PostgreSQL as the only stateful service; estimated infra cost per shop is in the architecture doc, Section 16. |
| D9 | **SMS and WhatsApp:** cheapest viable Indian options behind a pluggable provider interface. | Default WhatsApp via Meta Cloud API direct, SMS (DLT) as fallback, free click-to-chat for Lite plans (architecture doc, Section 15). |
| D10 | **Built mostly by AI coding agents.** | Contract-first (OpenAPI) workflow with tests before code, strict conventions, coverage and mutation gates, and human review gates for money, tax and security (architecture doc, Section 14). |

### Decisions update (v0.4, 20 Oct 2026)

| # | Decision | Consequence for this spec |
|---|---|---|
| D11 | **White-labelling is required.** It covers: a partner/reseller level above tenants; per-tenant branding (app name, logos, colour tokens, fonts, login page, PWA manifest/icons per host); custom domains with automatic TLS; versioned per-tenant print templates; per-tenant WhatsApp/SMS/email senders; branding resolution tenant → partner → platform default; full rebrand for dedicated/on-prem; a white-label fee as a pricing option. **No hard-coded brand or colours in the frontend; a design-token system exists from day one.** | New Section 6.11; a Partner persona; roadmap items in Phases 0–2. Design detail is in the architecture doc, Section 20. |
| D12 | **14 functional NestJS modules**, each owning its tables and routes and talking only via services: Platform, Masters, Rates, Inventory, Sales, Orders & Repairs, Purchases, Refinery, Accounts, HR & Incentives, Approvals, Reports (read-only views), Notifications (outbox), SaaS Billing. **Only Sales writes invoices, only Inventory mutates stock, Reports never writes.** | Section 5 feature groups map to these modules (table at the start of Section 5). Module and ownership details are in the architecture doc, Section 4.1. |

### Decisions update (v0.5, 20 Oct 2026, master bot)

| # | Decision | Consequence for this spec |
|---|---|---|
| D13 | **Retail only;** manufacturing (karigar job work) deferred. **Plain self-managed PostgreSQL 17.** | Manufacturer/wholesale segments and karigar job cards are out of scope for now (Sections 3, 5.5). Orders, repairs (optionally outsourced) and refinery stay. |
| D14–D16 | **Data model v0.2** (`/workspace/jewellery-data-model`) is authoritative. Invoice and stock writes happen in the app through per-module writer roles; the DB keeps the locked gapless counter, immutable bills, the hash-chained audit log, forced RLS, the credit-note outbox trigger and a DDL guard. SQL migrations are the source of truth (`migrate.js` with checksums; `000_bootstrap.sql` once as superuser); Drizzle is for types only. | INV-1..INV-6 enforcement is updated in the architecture doc, Sections 4.1 and 11. No change to the requirements in Section 6.10. |
| D17 | **Accounts exposes a function that Sales calls inside the invoice transaction.** | Ledger postings for a bill commit or roll back with it. |
| D18–D19 | *(Rounding refined by D34.)* **Money `numeric(14,2)`, weights `numeric(12,3)`, decimal strings on the wire.** Rounding: line amounts to 0.01 half-up; each tax component computed and rounded separately; invoice total rounded to ₹1 by default (configurable). | Section 7 data-precision NFR. |
| D20 | **Auth:** server-side Postgres sessions in httpOnly cookies; password with optional OTP; counter device registration. | Sections 6.5 and 7 (replaces "MFA for admins" and "or JWT"). |
| D21 | *(Superseded by D29: no offline billing.)* **Offline bills** get a provisional receipt; the gapless number is assigned at sync. `doc_date` is the sale date (at most 5 min in the future); back-dating beyond 72 h needs a permission. Reports and GSTR-1 group by `doc_date`. | Section 7 counter resilience; Section 6.10 INV-1. |
| D22–D24 | **A client-supplied invoice number is rejected. HUID** is 6 alphanumeric characters, normalised to uppercase. **Only tax invoices and credit notes are gapless.** Cancelling across financial years means a credit note in the current FY. | Sections 2, 6.1 and 6.10. |
| D25–D26 | *(Alerts made configurable by D36.)* **Alerts on every cancellation plus a daily summary.** **PAN threshold configurable, default ₹2 lakh.** Errors tracked in the Sentry free tier. | Sections 5.3, 6.10 and 7. |
| D27–D28 | **Dev environment:** owner's Ubuntu server (2 vCPU, 8 GB), Docker Compose, GitHub Actions with a self-hosted runner. **Bot team:** master, data, backend, frontend, QA, DevOps. | Architecture doc, Sections 13 and 14. |

### Decisions update (v0.6, 20 Oct 2026, owner overrides and accepted decisions)

| # | Decision | Consequence for this spec |
|---|---|---|
| D29 | **No offline billing at all** (overrides D21). Billing is blocked when the internet or server is unreachable; no provisional receipts, offline queuing or sync numbering. **`doc_date` is the server date in IST.** Offline/PWA support is limited to **read-only cached screens**. | Section 7 counter resilience; Section 6.10 INV-1; back-dating no longer applies to tax invoices (Sections 5.10, 6.5). |
| D30 | **Language is a master setting:** tenant default plus a user override. Invoices and prints can optionally use **any chosen language per print**, including the amount in words and **native numerals**. | New Section 6.12; Section 7 usability. |
| D31 | **GST rates are managed in Settings** (effective-dated). | Sections 5.12 and 6.1. |
| D32 | **Guided onboarding wizard:** a resumable 10-step stepper; "Start billing" only after steps 1, 2, 4, 5 and 6; a dashboard checklist card until setup is complete. | Section 6.2 rewritten. |
| D33 | **Outbox `ref_type` / `ref_id` / `alert_type` columns with a partial unique index.** | One alert per document and alert type (Section 6.10 INV-5). |
| D34 | **Per-line tax rounding,** each tax component rounded separately. | Section 7 data precision. |
| D35 | **An invoice's only allowed change is the guarded status transition issued → cancelled.** | Section 6.10 INV-4. |
| D36 | **INV-5 thresholds are configurable.** Defaults: alert on every cancellation; escalate when there are more than 5 per branch per day; no summary on zero days. | Section 6.10 INV-5. |
| D37 | **The API writes outbox rows; the worker (`app_worker`) enqueues them to pg-boss** in a `pgboss` schema. | Architecture doc, Sections 3, 7.2 and 15. |

---

## 1. Executive summary

1. The frontend covers the operations of a mid-sized Indian jewellery retailer (Tamil Nadu by default) more broadly than expected. It has masters for metal, purity, daily rates and tax; lot-based tagging with HUID and stone/diamond details; estimate-to-bill with old-gold exchange, chit amounts, advances and sales returns; customer orders and repairs; vendor purchases with pure-weight, touch and rate-cut settlement; melting and purification with a refinery; stock transfer between branches; staff incentives and counter targets; and about 30 reports.
2. It is **single-tenant and backend-less**. The API base URL is a hard-coded LAN IP (`http://192.168.1.104:8000`). The URL layout (`/accounts/`, `/masters/`, `/books/`, `/billing/`, …) and `Authorization: Token …` headers suggest a Django REST Framework backend that is not in the repository. You must rebuild it or obtain it. Nothing for tenants, signup, subscriptions or audit logs exists.
3. **Critical compliance finding:** the billing and stock-list screens contain a hidden, secret-gated mode. Holding the footer text for about 2 seconds and entering a 10-character secret switches billing to a separate "backup" bill-number series and endpoint (`/billing_backup/…`). It also switches the stock list to an alternate list. A second hidden gesture calls `/billing_backup/truncate-model/`, which appears to wipe that data. Whatever the original intent, a parallel, hidden and erasable invoice series breaks GST invoice-integrity and audit-trail expectations. **Owner decision (D2): the mode is being dropped.** Its removal is a concrete Phase 0 task (Section 9), and Section 6.10 adds invoice-integrity requirements so it cannot return.
4. The domain logic is valuable: making-charge and wastage calculation types, min/max sale guardrails per tag, purity-based rates, old-metal rates, and pure-weight vendor settlement. Code quality is uneven. The billing UI is duplicated across four modules (~29k lines). Invoice printing hard-codes CGST/SGST at 1.5% each and the state "Tamil Nadu". The dashboard is a placeholder. There are no tests.
5. **Recommended MVP:** a single-branch shop running "rate → tag → estimate → bill → GST reports → backup", on a properly multi-tenant backend with self-serve onboarding, plan-based subscriptions, role permissions and an immutable audit log. Multi-branch, orders/repairs, vendor settlement, refinery and full accounting follow in later phases (Section 9).

---

## 2. Product vision

**Vision (suggested):** the operating system for India's independent jewellers. One cloud product that runs the counter, the locker and the books: daily metal rates, HUID-tagged stock, GST-correct billing with old-gold exchange, and vendor/karigar settlement in both rupees and grams. It should be affordable for a single-counter shop and scale to a multi-branch chain.

**Why now (context, suggested):**
- Hallmarking with a 6-character alphanumeric HUID (stored uppercase, D22) is mandatory for most gold jewellery, so shops need item-level traceability.
- GST compliance needs correct invoices, HSN and returns. E-invoicing applies above the turnover threshold.
- Many shops still run legacy desktop software or spreadsheets. A cloud product removes the on-premise server (the current frontend assumes a LAN server) and gives owners remote visibility.

**Product principles (suggested):**
1. Weight-first and rupee-first: every stock and ledger value is held in grams (by purity) and in rupees.
2. Counter speed: keyboard-driven billing (the current UI already uses many Ctrl/F1 shortcuts) and barcode scanning.
3. Compliance by default: GST, HUID, PAN/cash-limit checks, immutable invoices, audit trail.
4. Tenant isolation and trust: a shop's data is private, exportable and backed up.

## 3. Target customers

| Segment | Profile | Fit with existing screens | Priority (suggested) |
|---|---|---|---|
| Single-store retail jeweller | 1 branch, 2–15 staff, gold + silver, some diamond | Strong (masters, tagging, billing, old gold, reports) | **Primary for MVP** |
| Multi-branch retail chain | 2–20 branches, transfers, counters/floors, targets | Strong (branch, floor/counter, box, stock transfer, targets) | Phase 2 |
| Retailer with in-house/karigar manufacturing | Customer orders, designers, repairs, melting old gold | Good (orders, designer assignment, repairs, refinery) | Orders, repairs and refinery in Phase 2–3; **manufacturing deferred (D13)** |
| Wholesaler / B2B supplier to shops | Goods on approval to shops, metal-to-metal settlement | Partial (requisition approval to "shops", vendor rate-cut) | **Out of scope: retail only (D13)** |
| Silver-only / small rural shops | Low price point, simple billing | Good, but needs a "lite" plan | Pricing tier |

Initial geography (suggested): Tamil Nadu and South India first (default state in code is Tamil Nadu; owner is in Coimbatore), then pan-India with regional languages.

## 4. Personas and roles

Today's role model **[Exists]**: user roles (`/userrole`, `pages/userrole`) with an "Is Admin" flag, and a menu-permission matrix per role with View / Add / Edit / Delete per menu (`/menupermission`, `pages/menupermission`). Users are linked to a branch, department and designation (`pages/user`). The sidebar is filtered by the active user's permitted menus (`layout/sidebar.jsx`).

| Persona | Goals | Key screens | Suggested SaaS role |
|---|---|---|---|
| Shop owner / proprietor | Profit, stock safety, staff control, compliance | Dashboard, reports, approvals, settings | Tenant Owner (full access, billing/subscription) |
| Branch manager | Daily rates, counter operations, transfers, targets | Metal rates, stock transfer, targets, approvals | Branch Admin |
| Billing / cash-counter operator | Fast, correct bills and payments | Estimate billing, billing, payments, cash counter | Cashier |
| Sales staff (counter) | Prepare estimates, earn incentives | Estimate billing, stock list, tag details | Salesperson |
| Stock / tagging clerk | Receive lots, tag with HUID, print labels | Lot, item tag, tag update, duplicate tag, box | Stock Keeper |
| Purchase / vendor manager | Buy stock, settle vendors in cash or metal | New purchase, vendor payment/discount/ledger | Purchase Manager |
| Workshop / order coordinator | Orders, karigar assignment, repairs | Order, repair creation, value addition designer | Workshop Coordinator |
| Refinery coordinator | Old gold to melting to purification | Transfer creation, melting/purification issue and receipt | Refinery Operator |
| Accountant / CA | Ledgers, GST returns, reconciliation | Books, credit/debit, tax audit, reports | Accountant (incl. read-only Auditor variant) |
| Partner / reseller admin **[Suggested, from D11]** | Resell the product under their own brand, onboard and support their shops | Partner portal: tenants, branding, domains, templates, billing | Partner Owner / Admin / Support / Finance (no access to tenant business data without a consented support session) |
| SaaS platform admin (your team) | Onboard tenants, plans, support, health | Platform console **[Suggested]** | Platform Super-admin, Support (time-boxed impersonation with audit) |

---

## 5. Module-by-module feature list

**Mapping to code modules (decision D12):**

| Spec section | Owning module(s) |
|---|---|
| 5.1 Organization, infrastructure and masters | Platform (org, users, roles); Masters (metal, purity, tax, items, standards, value addition, customers, vendors); Rates (daily, old-metal and carat rates) |
| 5.2 Tagging and inventory | Inventory (only module that mutates stock) |
| 5.3 Sales and billing; 5.4 Estimates | Sales (only module that writes invoices and credit notes) |
| 5.5 Orders and repairs | Orders & Repairs |
| 5.6 Purchases and old metal | Purchases (stock in via Inventory) |
| 5.7 Melting and purification | Refinery (metal movements via Inventory) |
| 5.8 Accounts, advances and vendor payments | Accounts (ledgers, advances, suspense); Purchases (vendor settlement documents) |
| 5.9 Staff, incentives and targets | HR & Incentives |
| 5.10 Approvals | Approvals (never mutates other modules' data; the owner module applies the outcome) |
| 5.11 Reports | Reports (read-only views; never writes) |
| 5.12 Settings and permissions | Platform |
| 6.x Notifications | Notifications (outbox, per-tenant senders) |
| 6.3 Subscriptions, white-label fees | SaaS Billing |

Each feature lists the **existing screen(s)** (route; `src/pages` folder). Anything not in the code is marked **[Suggested]**.

### 5.1 Organization, infrastructure and masters

**Organization**
- **[Exists]** Organization structure: locations, branches (code, name), departments, designations. `/organization/organizations`; `pages/organization` (sub-folders `locations`, `branches`, `department`, `designation`).
- **[Exists]** Staff master with basic details, address, Aadhaar/PAN numbers and attachments. `/organization/staff`; `pages/staff`.
- **[Exists]** Users with role, branch, password change and a "Logged In" status. `/organization/user`; `pages/user`.
- **[Exists]** Company (legal entity) with GSTIN, GST type/status, PAN, address and multiple bank accounts. GSTIN lookup goes through `/settings/gst-verification/`, IFSC lookup through `/settings/ifsc-verification/`. `/books/company`; `pages/company`.

**Infrastructure (showroom layout)**
- **[Exists]** Floors and counters per branch. `/infrastructure/floor-counter`; `pages/infrastructure`.
- **[Exists]** Boxes (trays) per counter and sub-item, with box weight. `/infrastructure/box`; `pages/box`.
- **[Exists]** Box weight verification. A physical weighing check compares entered weight with system gross/net weight and pieces, and shows the difference. `/infrastructure/box-weight-verification`; `pages/boxweightverification`.
- **[Exists]** Cash counters with password protection; billing asks for the counter and password (`pages/billingpopup`). `/masters/cash-counter`; `pages/cashcounter`.

**Metal, purity, rates and tax**
- **[Exists]** Metals and purities (code, purity %, "header visible" flag for the rates shown in the app header). `/masters/metal-purity`; `pages/metalcreate`.
- **[Exists]** Daily metal rates per metal/date and purity-based rate lookup. Today's gold/silver rates appear in the header and on prints. `/masters/metal-rates`; `pages/metalrates`, `pages/dailymetal`.
- **[Exists]** Old-metal (exchange) rates, separate from selling rates. `/masters/old-metal-rate`; `pages/oldmetalrate`.
- **[Exists]** Tax master per metal: CGST/SGST/IGST %, surcharge %, additional charges, separate purchase and sales details. `/masters/tax`; `pages/Taxs`.
- **[Exists]** Tax audit mapping (metal ↔ tax). `/masters/tax-audit`; `pages/taxaudit`.
- **[Suggested]** Rate feed integration (e.g., association/IBJA-style daily rates) with approval before publishing; rate history and audit.

**Product masters**
- **[Exists]** Item master: metal, purity, HSN code, item code/short code, stock type (tag / non-tag / packet), counter, image, **HUID rate** (hallmarking charge), and making-charge and wastage calculation types (fixed, by weight, per gram, per piece), per-gram/per-piece/min rates, "allow zero weight". `/product-master/item-master`; `pages/itemmaster`.
- **[Exists]** Sub-item master with the same pricing parameters, measurement type, HSN and image. `/product-master/sub-item-master`; `pages/subitem`.
- **[Exists]** Stone/diamond standards: shape, cut, clarity, colour, stone, cent group (weight bands). `/masters/standard`; `pages/standard`.
- **[Exists]** Tag types and carat rates (diamond purchase/selling rate by cent group, shape, clarity, colour, cut, designer). `/masters/tag`; `pages/createtag`.
- **[Exists]** Range stock (size/weight ranges per item, with a range-stock report). `/masters/rangestock`; `pages/rangestock`.
- **[Exists]** Repair types with min/max customer and vendor charges. `/masters/repair-type`; `pages/repairtype`.

**Value addition (pricing rules)**
- **[Exists]** Customer value addition: wastage %, flat wastage, MC/gram, flat MC and fixed rate by metal/item/sub-item/tag type and weight band. `/valueaddition/valueaddition-customer`; `pages/valueadditioncustomer`.
- **[Exists]** Designer (supplier) value addition with touch, wastage, MC and Purchase / Retail / "VIP Retail" columns. `/valueaddition/valueaddition-designer`; `pages/valueadditiondesigner`.

**Customers and parties**
- **[Exists]** Customer master: name, phone, email, DOB, marriage date, GSTIN, PAN, Aadhaar, UPI ID, address, customer group, branch, and customer view. `/books/customer`; `pages/customer`.
- **[Exists]** Customer groups. `/books/customergroup`; `pages/customergroup`.
- **[Exists]** Account heads (vendors/designers/buyers/diamond sellers) with GST/PAN/TIN, multiple addresses, contacts and bank accounts, and opening credit/debit balances in ₹ **and grams**. `/books/account-head`; `pages/accounthead`.

### 5.2 Tagging and inventory

- **[Exists]** Lot entry for stock inward: entry type, designer/vendor, reference invoice, hallmark centre and number, items with gross/net/stone/diamond/cover/loop/other weights, tag count, and tagging progress (tagged vs remaining pieces and weight). `/stock/lot`; `pages/lot`.
- **[Exists]** Item tagging from a lot. Each tag holds gross/net/tag/cover/loop weight, size, stone and diamond lines (weight type, rate type, pieces), counter assignment, calculation type, min/max wastage, MC, per-gram and sale value (pricing guardrails), and **Hallmark HUID per tag**. Saving is blocked until every HUID field is filled. Bulk tagging is supported, and barcode/QR codes are rendered. `/stock/itemtag`; `pages/itemtag`.
- **[Exists]** Tag details view and print (item age, billed flag, remaining weights). `/stock/tag-details`; `pages/tagdetails`, `components/Printouts/tagprint.jsx`.
- **[Exists]** Tag update, single and multiple. `/stock/tag-update`; `pages/Tagupdate`.
- **[Exists]** Duplicate tag printing (number of copies, with audit of who created it). `/stock/duplicate-tag`; `pages/dublicatetag`.
- **[Exists]** Stock list filtered by branch, counter, item, sub-item, lot, stock type, tag type and bill status, with print and Excel export. `/stock/stock-list`; `pages/stocklist`. *(Contains the hidden alternate-list switch; see Section 8.)*
- **[Exists]** Stock ledger: movement by item, sub-item, tag, vendor and entry type. `/stock/stock-ledger`; `pages/stockledger`.
- **[Exists]** Inter-branch stock transfer with a transfer → approve → receive → return workflow, barcode scanning and transfer authority. `/stock/stock-transfer`; `pages/stocktransfer`.
- **[Exists]** Packet / non-tag stock types (constants `tagStockType`, `nonTagStockType`, `packetStockType`).
- **[Suggested]** RFID tag support, physical stock-take (cycle count) with variance approval, HUID verification against BIS data (if an API is available), and an ageing/dead-stock dashboard.

### 5.3 Sales and billing

- **[Exists]** Sales billing (invoice). Covers branch, metal type (gold/silver bill series), bill number and date, customer lookup by mobile or quick-add, and GST type (intra-state CGST+SGST / inter-state IGST). Items are added by tag number with stone and diamond lines. The rate is metal rate × weight + wastage + MC + stone + diamond + **HUID charge**. Tag min/max sale values act as guardrails. Duplicate tags in one bill are blocked. `/billing/billing`; `pages/invoice`.
- **[Exists]** Conversion of approved estimates into a bill; several estimates can be merged into one bill.
- **[Exists]** Old gold / old metal exchange inside the bill: gross, dust and net weight, old rate, item code, and its own old-gold number. `pages/invoice/oldgoldandpayment`.
- **[Exists]** Sales return inside the bill, either automatic (by tag/bill) or manual entry, governed by the "Sales Return Policy Days" setting. `pages/invoice/salesreturnform.jsx`, `salesreturnmanual.jsx`; `/settings` (`pages/appconfig`).
- **[Exists]** Chit/scheme redemption amount and gift voucher as bill inputs. `pages/invoice/chitandsale`. *(Chit amount is entered manually. A third-party chit endpoint is defined but not used.)*
- **[Exists]** Advance and suspense adjustment against the bill. `pages/invoice/advanceandsuspence`, `advancepopup`.
- **[Exists]** Split payments by method and provider: cash, UPI, debit card, credit card, bank transfer, gift voucher, scheme, cheque. Also discount, round-off and balance. `pages/invoice/paymentdetails`, `oldgoldandpayment/paymentcreate.jsx`.
- **[Exists]** Keyboard shortcuts in billing: Ctrl+G toggles GST, F1 opens payment, Ctrl+S saves, Ctrl+R goes back.
- **[Exists]** Invoice print (A4/thermal selected through a print-size list), amount in words, declaration, gold/silver rate of the day. `components/Printouts/InvoicePrint.jsx`. *(Gaps: CGST/SGST are hard-coded at 1.5% each, the state is hard-coded as "Tamil Nadu", and there is no HSN, HUID or customer GSTIN column. See Section 8.)*
- **[Exists]** Misc billing / misc issue, a non-tag sale or issue with giver name and items. `/billing/misc-billing`; `pages/miscissue`.
- **[Exists]** Customer credit/debit: outstanding balances, payments, reminder dates and payment history. `/books/credit-debit`; `pages/creditdebit`.
- **[Suggested]** Credit notes and debit notes as GST documents, invoice cancellation with reason (no deletion), e-invoice (IRN/QR) above the threshold, PAN capture at a configurable threshold (default ₹2 lakh, D26) and cash-receipt limit checks, WhatsApp/SMS e-bill, and customer loyalty points.

### 5.4 Estimates

- **[Exists]** Estimate billing: the same item engine as billing (tags, stones, diamonds, old gold, sales return, advance, chit, discount, GST), with an estimate number and print. `/billing/estimate-billing`; `pages/estimatebilling`, `components/Printouts/EstimationPrint.jsx`.
- **[Exists]** Estimation edit. `/billing/estimation-edit`; `pages/estimationedit`.
- **[Partial]** Estimation and billing approval (pending/approved/denied). Routes exist (`/approval/billing-estimation-approval`; `pages/estimatebillingapproval`), but the menu entry is commented out.
- **[Exists]** Estimation report. `/reports/estimation-report`; `pages/estimation_report`.
- **[Suggested]** Estimate validity/expiry, rate lock on an estimate, and an approval trigger when the discount or price falls below the tag minimum.

### 5.5 Orders and repairs

**Customer / shop orders**
- **[Exists]** Orders for a customer or a shop: order number, priority, gender, items with weights and stones, due dates, image/attachment upload, designer assignment, advances (cash, grams, old gold), payments, cancellation, receiving finished items, and lot creation from an order. Order receipt print. `/order/order`; `pages/order`, `components/Printouts/OrderReceiptPrint.jsx`.

**Repairs**
- **[Exists]** Repair creation: customer repair order, repair type, items and weights, customer charges, advance/old gold/scheme/voucher payments, card/cheque/denomination details. `/repair-management/repair-creation`; `pages/repairmanagement`.
- **[Exists]** Repair issue to vendor, vendor receipt, customer receipt, delivery note/bill, repair payment (API endpoints under `/repair-management/` used by the repair screens). Customer repair issue report: `/report/issue-customer-report`; `pages/repairissuecustomer`.
- **[Suggested]** SMS/WhatsApp status updates to customers, and an order production Kanban. (Karigar job cards with metal issue/receipt and loss checks are **deferred** with manufacturing, D13.)

### 5.6 Purchases and old metal

- **[Exists]** New purchase (vendor purchase order/entry): PO ID and date, vendor, items with gross/less/net/pure weight, stones, diamonds, MC type, hallmark charge, GST type, payment due days, advance and pending amounts. `/order/new-purchase`; `pages/newpurchase`, `components/Printouts/PurchasePrint.jsx` *(print template contains hard-coded sample values)*.
- **[Exists]** Old purchase (buying old gold/silver from customers): customer, gross/dust/less/net weight, touch, metal rate, old-metal bill number, GST fields. `/order/old-purchase`; `pages/oldpurchase`.
- **[Exists]** Old-gold management APIs used from billing (number generation, search, list).
- **[Suggested]** Old-gold purity testing record (XRF/touchstone result and photo), KYC capture for old-gold sellers, and a purchase-return document.

### 5.7 Melting and purification (refinery)

- **[Exists]** Transfer creation: bag old gold, purchased scrap or returns by date range, designer, lot, bill or category into a numbered bag with gross/net/dust weight totals. `/refinery-management/transfer-creation`; `pages/transfercreation`.
- **[Exists]** Melting issue to a smith: bag, category, bullion rate, stone weight, expected melt return, due days. `/refinery-management/melting-issue`; `pages/meltingissue`.
- **[Exists]** Melting receipt: received net weight, melting loss weight, melting charges, payment status. `/refinery-management/melting-receipt`; `pages/meltingreceipt`.
- **[Exists]** Purification issue: issued pure weight, touch, due days. `/refinery-management/purification-issue`; `pages/purificationissue`.
- **[Exists]** Purification receipt: received pure weight and metal, touch, purification charges, payment status. `/refinery-management/purification-receipt`; `pages/purificationreceipt`.
- **[Suggested]** Loss-tolerance alerts per smith/refiner and a refinery reconciliation report (issued vs returned pure weight).

### 5.8 Accounts, advances and vendor payments

- **[Exists]** Account groups (group type, group under, group ledger). Routed at `/books/account-group`; `pages/accountgroup`.
- **[Exists]** Account heads (see 5.1).
- **[Exists]** Advance payments from customers in cash or in metal weight/purity, with purpose and redeem status. `/books/advance-payment`; `pages/advancepayment`.
- **[Exists]** Suspense accounts: a customer deposit held against metal weight or amount, with payments and redeem/cancel status. Exact business meaning to be confirmed. `/masters/suspense`; `pages/suspense`.
- **[Exists]** Vendor payment (settlement) with four modes (Cash→Cash, Cash→Metal, Metal→Cash, Metal→Metal), rate-cut by amount/metal/cash, touch and pure weight, discount, and balances in ₹ and grams. `/payment-target/vendor-payment`; `pages/newvendorpayment` and `pages/vendorpayments`.
- **[Exists]** Vendor discount in amount and weight. `/payment-target/vendor-discount`; `pages/vendordiscount`.
- **[Exists]** Vendor ledger: transaction amount and weight, cancelled flag. `/payment-target/vendor-ledger`; `pages/vendorledger`.
- **[Suggested]** A real double-entry accounting core: vouchers (receipt, payment, journal, contra), day book, cash book, bank reconciliation, trial balance, P&L, balance sheet, GSTR-1/GSTR-3B data, and Tally/Busy export. Today only masters and party ledgers exist; there are no voucher or financial-statement screens.

### 5.9 Staff, incentives and targets

- **[Exists]** Incentive slabs by amount range, as a percentage or a fixed amount, with incentive types. `/books/incentive`; `pages/incentive`.
- **[Exists]** Sales incentive reports (percentage and amount) per salesperson. `/reports/sales-incentive-percentage-report`, `/reports/sales-incentive-amount-report`; `pages/saleincentivepercentreport`, `pages/saleincentiveamountreport`.
- **[Exists]** Counter targets by date range (amount/pieces/weight) with achieved vs remaining. `/infrastructure/counter-target`; `pages/target`.
- **[Exists]** Employee/staff ID captured on estimates and bills (staff ID search).
- **[Suggested]** Staff attendance hooks, per-staff targets, and an incentive payout ledger.

### 5.10 Approvals

- **[Exists]** Requisition approval ("goods on approval"): issue tagged items to a shop or customer with a receiver name, barcode scan and print. Items are later returned to stock, converted to sale, or receipted. `/approval/requisition-approval`, `/approval/requisition-approval-receipt`; `pages/requisitionapproval`, `components/Printouts/RequisitionApprovalPrint.jsx`.
- **[Partial]** Approval types and rules (approval type → approver role/users). Screens and routes exist (`/approval/approval-type-rule`; `pages/approvaltype&rule`), but they are hidden from the menu.
- **[Partial]** Estimation/billing approval; see 5.4.
- **[Exists]** Stock-transfer approval step; see 5.2.
- **[Suggested]** A generic approval engine for discounts below the minimum, rate overrides, bill cancellation, back-dated entries (not tax invoices or credit notes, whose `doc_date` is always the server date, D29) and stock adjustments, with mobile push for the owner.

### 5.11 Reports

All listed reports **[Exist]** as filter + table screens. Most include Excel export (`components/ExportToExcel`) and an in-app spreadsheet viewer.

| Area | Reports (route) |
|---|---|
| Sales | Daily sales (`/report/daily-sales-report`), sales details (`/report/sales-details-report`), sales by customer (`/report/sales-by-customer-report`), customer sale (`/report/customer-sale-report`, `/reports/customer-sale-report`), metal-wise, item-wise and purity-wise sale (`/reports/metal-wise-sale-report`, `/reports/item-wise-sale-report`, `/reports/purity-wise-sale-report` — the purity report is not in the menu), cash-counter collection by payment method (`/reports/cash-counter-report`), estimation (`/reports/estimation-report`) |
| Stock | Tag report, item-wise report, stock summary, tag-wise stock, lot report, daily stock (opening/closing pieces and weight) by item / sub-item / metal / purity / designer (`/reports/daily-stock-*`), range-stock report |
| Purchase | Purchase, item-wise purchase, vendor-wise purchase (with pure grams), old purchase |
| Repairs | Issue customer report |
| Staff | Sales incentive % and amount |

- **[Partial]** Dashboard: the route `/dashboard` renders only the word "Dashboard". Eight dashboard endpoints (counts, metal-wise sales, sales vs purchase, vendor-wise and so on) are defined but unused.
- **[Suggested]** GST reports (GSTR-1 B2B/B2C/HSN summary, GSTR-3B summary), HUID register, profit by item/sale (needs cost tracking), owner mobile dashboard, scheduled email/WhatsApp reports, and PDF exports.

### 5.12 Settings and permissions

- **[Exists]** Login by email or phone plus password; token stored in `localStorage`; 401 triggers logout; change password; session refresh hook with a 15-minute window. `src/auth/login.jsx`, `service/axios_service.jsx`, `hooks/useRefreshToken.jsx`.
- **[Exists]** User roles and role-wise menu permissions (View/Add/Edit/Delete). `/userrole`, `/menupermission`.
- **[Exists]** Application settings: pagination toggle and sales-return policy days. `/settings`; `pages/appconfig`.
- **[Exists]** Branch scoping: the login response carries a `branch` flag, and list screens use it to show all branches or only the user's own.
- **[Exists]** Home "shortcut creation" and the global keyboard-shortcut menu. `pages/home`, `constant/app_constants.js`.
- **[Partial]** Menu configuration APIs (menu, menu group, main menu) exist in endpoints, but the menu structure is hard-coded in `app_constants.js`, and `src/assets/data/menu.json` is **empty (0 bytes)**.
- **[Exists]** Maintenance, 404 and 500 pages. `src/session`.
- **[Required, D31]** **GST rates managed in Settings:** effective-dated rate rules per component (metal, making, stone, hallmarking, service) with HSN/SAC, CGST/SGST/IGST and cess, platform defaults that a tenant can override, and no hard-coded rates anywhere.
- **[Required, D30]** **Language settings:** tenant default language, per-user override, and the default print language and numeral system (Section 6.12).

---

## 6. New SaaS capabilities required

None of the following exist in the frontend. All are **[Suggested]**.

### 6.1 Multi-tenancy
- Tenant = a jewellery business (legal entity or group). It contains companies (GSTINs), then branches, then floors/counters/boxes. The code already has company and branch levels.
- Isolation: shared database with `tenant_id` on every row, enforced by PostgreSQL Row-Level Security plus the application layer. Optional dedicated database for enterprise tenants.
- Tenant-scoped number series (bill, estimate, PO, old gold, repair, order) per company/branch/financial year. **Only tax invoices and credit notes are gapless** (D23); the others are unique but not gapless.
- Tenant-level configuration that replaces today's hard-coded values: state, GST rates (managed in Settings, D31), language (D30), print templates, metals/purities seed data, return-policy days, shortcuts.

### 6.2 Shop onboarding and signup
- Self-serve signup (mobile OTP plus email), business details, GSTIN verification (reusing the existing GST-verification idea), first branch, owner user.
- **Guided onboarding wizard (D32):** a **resumable 10-step stepper** (progress is saved after each step, and the owner can leave and resume on any device):
  1. Shop profile.
  2. GST/GSTIN with validation, and the invoice series.
  3. Branches (GSTIN optional, needed only for branches in other states).
  4. Metals and purities (seeded: 22K 916, 18K 750, 24K 999, silver 925 and so on).
  5. GST rates with effective dates.
  6. Today's rates.
  7. Users and roles.
  8. Branding with a live preview.
  9. Printers and print language/numerals, with a test print.
  10. CSV/Excel import with a dry run (6.8).
- **"Start billing"** is enabled only after steps **1, 2, 4, 5 and 6** are complete (also enforced by the server). A **setup checklist card** stays on the dashboard until setup is complete.
- Sample data / demo tenant, guided tours, and an import step (6.8).

### 6.3 Subscription plans and billing
- Plans gated by branches, users/counters, modules (refinery, orders/repairs, accounting) and invoice volume. Example: Lite (1 branch, 3 users, billing + stock), Standard (+orders/repairs/vendor), Pro (multi-branch, refinery, accounting, API).
- Monthly or annual billing via an Indian payment gateway with UPI AutoPay / e-mandate, GST invoices for the subscription itself, trials, grace periods, dunning, and read-only mode on lapse (never lock a shop out of its data or exports).
- Feature-flag service tied to the plan.
- **White-label fee (D11)** as a plan option: a tenant "own brand" add-on, a partner/reseller programme with wholesale pricing, and a full-rebrand pack for dedicated/on-prem (amounts suggested in the architecture doc, Section 17).

### 6.4 Multi-branch
- Branch-scoped data and users (partly modelled today), consolidated owner views, inter-branch transfer (screens exist), branch-wise number series and rates, and a branch-level cash book.

### 6.5 Roles and permissions
- Keep the existing menu × CRUD matrix as a base. Add action-level permissions (cancel bill, override rate, below-minimum discount, back-date (non-GST vouchers only, D29), export, view cost/purchase price), branch scoping, and field masking (hide purchase cost and customer PAN/Aadhaar from non-privileged roles).
- System role templates (Section 4) plus custom roles per tenant.
- Password login with optional OTP (D20), server-side sessions, counter device registration, session management, and IP/branch-location restrictions (optional).

### 6.6 Audit logs
- An append-only audit log for every create, update, cancel and print on transactional documents, plus logins, permission changes, rate changes and exports. Store before/after values, user, branch, device/IP and timestamp.
- Invoices are never hard-deleted. Corrections happen through cancellation or credit notes. This also supports the audit-trail expectations on accounting software in India.
- Owner-facing audit viewer and an export for the auditor.

### 6.7 Backups and data portability
- Managed PITR backups (for example RPO ≤ 15 min, RTO ≤ 4 h), daily snapshots kept 30–90 days in India-region storage, and periodic restore drills.
- Tenant self-service export (Excel/CSV plus PDF invoices) at any time, including after a subscription lapses.
- Replace the existing "billing_backup" concept entirely (Section 8). "Backup" in the SaaS means disaster recovery, not a parallel bill series.

### 6.8 Data import
- Excel/CSV templates with validation and dry-run for customers, vendors/account heads, items and sub-items, opening tagged stock (with HUID, weights and stones), opening balances (₹ and grams), and pending orders/advances.
- Import adapters for common legacy jewellery packages (to be identified with pilot customers).

### 6.9 Other platform capabilities
- Platform admin console (tenants, plans, usage, health, support impersonation with consent and audit).
- Notifications: SMS/WhatsApp/email for bills, order/repair status, rate broadcasts, and birthdays/anniversaries (DOB and marriage date are already captured).
- Integrations: e-invoice IRP, payment terminals/UPI QR, weighing scales, barcode/label printers, Tally export, and a rate feed.
- A public API and webhooks (Pro plan).

### 6.10 Invoice integrity controls (required, from owner decision D2)
These requirements are **mandatory**, not suggestions. They exist so that a parallel or hidden billing mode cannot come back.
- **INV-1 Single gapless GST invoice series:** exactly one tax-invoice number series per branch (GSTIN place of business) per financial year (1 Apr–31 Mar). Numbers are allocated by the server inside the same database transaction that commits the invoice. They are strictly sequential with no gaps or reuse, and the client cannot set or override them (no "manual" bill number for tax invoices). Metal type (gold/silver) may appear as a printed prefix or category only. It must not create a second independent series. Credit notes get their own single gapless series per branch per financial year. **Only tax invoices and credit notes are gapless** (D23); estimates and other documents are numbered separately. The invoice date (`doc_date`) is the **server date in IST** (D29), and there is no offline or provisional billing. A client-supplied invoice number is **rejected** (D22).
- **INV-2 No alternate billing paths:** there is exactly one bill-creation API, and every sale goes through it with GST computed server-side. No hidden modes, secret prompts, alternate endpoints, alternate stock views or "backup" tables for transactions. Code review and automated tests assert this. Example: a CI check that fails if routes or endpoints matching `backup`, `truncate` or equivalents exist in the transactional API.
- **INV-3 Immutable audit log:** append-only (no update or delete permission for any application role, including the tenant owner and platform support), with a tamper-evident hash chain per tenant, kept for at least 8 years (to be confirmed with a CA). It records every invoice, credit note and estimate create/print/reprint/cancel, every stock movement, rate change, permission change, login and export, with user, branch, device/IP, timestamp and before/after values.
- **INV-4 No deletion of bills:** issued invoices can never be deleted or edited (the **only allowed change is the guarded status transition issued → cancelled**, D35), whether through the UI, the API, an admin console or a bulk-truncate/maintenance endpoint. Physical deletion is blocked at the database level (no DELETE grant; triggers reject it). The only correction is **cancellation via a credit note**, which references the original invoice, requires a reason and the "cancel bill" permission, reverses stock and payments, and stays visible in reports and GST outputs. Cancelling an invoice from an earlier financial year issues the credit note in the **current** FY (D24).
- **INV-5 Cancellation alerts:** by default each cancellation or credit note (every one, D25) immediately notifies the tenant owner and branch admins in-app, plus email/WhatsApp/SMS per tenant settings. The alert gives invoice number, amount, user, reason and time. It is written only by a database trigger on the credit note (one alert per credit note and alert type, D33), so it cannot be skipped. **Thresholds are configurable (D36);** defaults: alert on every cancellation, escalate when a branch has more than 5 cancellations in a day, and send no daily summary on days with none. A daily summary lists all cancellations, reprints and below-minimum-price overrides. 
- **INV-6 Reconciliation:** a gap/sequence report per series, and a check that every number in the series appears in GST outputs (GSTR-1 document summary).

---

### 6.11 White-labelling and partners (required, from owner decision D11)
- **WL-1 Partner level:** partners (resellers) sit above tenants. They can onboard and manage their tenants' branding, domains, templates and subscriptions through a partner portal. They have no access to tenant business data without a consented, time-boxed, audited support session.
- **WL-2 Per-tenant branding:** app name, logos, colour tokens (CSS variables), fonts, login page, emails and PWA manifest/icons, all served per host. Resolution: **tenant → partner → platform default**, field by field.
- **WL-3 Custom domains:** self-service domain setup with DNS (TXT/CNAME) verification; automatic TLS certificates (Caddy on-demand TLS, gated by a verified-domain check).
- **WL-4 Versioned print templates** per tenant (invoice, estimate, credit note, receipt, tag label). Published versions are immutable, issued documents record the template version used, and invoice templates cannot be published without the mandatory GST fields.
- **WL-5 Per-tenant senders:** WhatsApp number/WABA, SMS DLT entity, headers and templates, email domain (SPF/DKIM verified). Same resolution order; no silent fallback to another brand's sender.
- **WL-6 Full rebrand for dedicated and on-prem** through a signed brand pack (app, installer, updater, print-agent, PDFs, emails).
- **WL-7 No hard-coded brand or colours:** the frontend uses a design-token system from day one. CI blocks colour literals and brand strings, and visual tests run under several sample brands.

### 6.12 Language and print localisation (required, from owner decision D30)
- **LANG-1 Master setting:** each tenant has a default language; each user can override it for their own UI.
- **LANG-2 Per-print language:** every invoice, estimate, credit note, receipt and label can optionally be printed in **any chosen language**. The tenant/branch print default is preselected and can be changed in the print dialog.
- **LANG-3 Amount in words and numerals:** the amount in words follows the print language (Indian lakh/crore style), and **native numerals** (for example Tamil or Devanagari digits) are an optional per-print choice. Stored data and GST return outputs keep standard digits.
- **LANG-4 Audit:** the language and numeral system used are recorded with each print/reprint.

## 7. Non-functional requirements (suggested)

| Area | Requirement |
|---|---|
| Performance | Tag lookup on scan < 300 ms p95; bill save < 2 s p95; reports up to 1 year of a 5-branch tenant < 10 s or run async |
| Availability | 99.5% monthly for the core billing API (99.9% target for paid Pro); planned maintenance outside 10:00–21:00 IST |
| Counter resilience | **No offline billing (D29):** billing is blocked when the internet or server is unreachable, with a clear banner; the PWA offers read-only cached screens (tag/price lookup, masters, rates). On-prem mode for poor-internet shops (D6), because the server is on the shop LAN. `doc_date` is the server date in IST (see architecture doc, Section 3.2) |
| Data precision | Weights as decimals with 3 dp (grams), purity to 2–3 dp, money as decimals with 2 dp (`numeric(14,2)`; weights `numeric(12,3)`), sent as decimal strings in the API (D18); rounding: line amounts to 0.01 half-up, tax computed per line with each component rounded separately (D34), invoice total to ₹1 by default (configurable) (D19); never floating point in the backend (the current frontend uses `parseFloat` heavily) |
| Security | TLS everywhere; server-side Postgres sessions in httpOnly cookies instead of a long-lived token in `localStorage` (D20); OWASP ASVS L2; encryption at rest; secrets in a vault; rate limiting; optional OTP; error tracking on the Sentry free tier |
| Privacy | DPDP Act 2023: consent and purpose notice for customer PII (phone, PAN, Aadhaar, DOB); mask Aadhaar (store last 4 digits or a token); retention policy; data hosted in India |
| Compliance | Invoice integrity controls INV-1 to INV-6 (Section 6.10, mandatory); immutable invoices and audit trail; GST-correct document formats; HUID captured per item and printed on the invoice; configurable statutory checks (PAN threshold default ₹2 lakh, cash limits); reports and GSTR-1 grouped by `doc_date` |
| Multi-tenancy | Proven tenant isolation (automated cross-tenant tests); noisy-neighbour limits; per-tenant encryption keys for enterprise (optional) |
| Scalability | Target 1,000 tenants and 10,000 concurrent counters in year 2 on horizontally scalable stateless APIs |
| Observability | Structured logs, metrics, tracing, error tracking, and per-tenant usage metering (for plans) |
| Usability | Keyboard-first billing (keep the existing shortcuts), works on 1366×768 counter PCs and tablets, English + Tamil first, then Hindi, Telugu, Kannada and Malayalam; language is a tenant setting with a per-user override, and any print can use any supported language and native numerals (Section 6.12) |
| Printing | A4, A5, 80 mm thermal and jewellery tag-label printers; tenant-editable templates; reprints watermarked "Duplicate" |
| Quality | Automated unit/integration tests for pricing and tax calculations (golden test cases from real bills); CI/CD; staging per release |
| Supportability | In-app help, support ticketing, and remote-session consent |

---

## 8. Gap list: what the existing frontend lacks or must fix

**Critical**
1. **No backend.** All 411 endpoints (about 28 backend apps: masters 65, billing 32, settings 28, report 28, tagging 27, product 24, repair-management 23 and so on) need an implementation. The API contract has to be reverse-engineered from the request and response fields used in the JSX.
2. **Hidden parallel billing / stock mode must be removed.** `layout/footer.jsx` uses long-press gestures on the "Powered by" and copyright text. These open secret prompts (`pages/invoice/authenticatepass.jsx`, `pages/stocklist/authenticatepass.jsx`). After that, billing uses `getBackupBillGoldNumberEndPoint` / `billingBackupEndPoint` (`/billing_backup/…`) instead of the normal series, the stock list uses `/tagging/huid-stock-list/`, and `/billing_backup/truncate-model/` is callable. The owner has confirmed that this mode let customers buy without GST. **Decision D2: dropped.** Removal is a Phase 0 task, and Section 6.10 prevents its return.
3. **No multi-tenancy, signup, subscription, platform admin, audit log or data import.**
4. **Legacy branding to replace.** The UI is branded "AuSales" with "Powered by ATTS · © 2024 ATTS PVT LMT" (footer, print templates, package name `ausales`) and links to a third-party chit service (`aupay.auss.co`). **Decision D1:** the owner wholly and exclusively owns the code, so there is no rights issue. Rebranding is a Phase 0 task.

**Compliance / correctness**
5. The invoice print hard-codes "CGST @ 1.5% / SGST @ 1.5%" and the state "Tamil Nadu". It does not print IGST for inter-state sales, HSN, HUID, customer GSTIN or place of supply. It has no credit/debit note documents.
6. No e-invoice (IRN/QR), no GSTR-1/3B outputs, and no PAN or cash-limit checks at billing.
7. Accounting is limited to masters and party ledgers. There are no vouchers, day book, trial balance, P&L or balance sheet.
8. Frontend calculations use JavaScript floats (`parseFloat`, `toFixed`). Pricing and tax must be computed authoritatively on the server.

**Product completeness**
9. The dashboard is a placeholder; its endpoints are unused.
10. Approval type/rule and estimation/billing approval are built but hidden from the menu.
11. There is no chit/gold-savings scheme module, only a manual "chit amount" field and an unused third-party endpoint.
12. No notifications (SMS/WhatsApp/email), no loyalty, no customer app, no i18n.
13. `PurchasePrint.jsx` contains hard-coded sample values (for example "SIVA", "PO- 0002", "Tamil Nadu 641041", "Purchase Type: Scrap").
14. `react-thermal-printer` is a dependency but is not used; printing goes through browser print (`react-to-print`).

**Engineering**
15. The base URL is a hard-coded LAN IP; there is no environment configuration.
16. `src/assets/data/menu.json` is empty; the menu is hard-coded in `app_constants.js` while menu-management APIs also exist (two sources of truth).
17. Heavy duplication: billing UI is copied in `invoice`, `estimatebilling`, `estimationedit` and `estimatebillingapproval` (~29k lines). There is a stray folder `pages/daily_stock_designer_report copy` (with a space in the name) and many misspellings in identifiers (for example `appConfigSlcie`, `dublicatetag`, `Reciept`).
18. No automated tests (only the CRA default `App.test.js`). Create React App (`react-scripts 5`) is deprecated; plan a move to Vite.
19. Auth token in `localStorage` (XSS exposure); no password reset, no MFA.
20. Dark-mode and theme flags exist in state, but there is no evidence of accessibility or responsive design testing.

---

## 9. Phased roadmap with priorities (suggested)

Priorities: **P0** = must have for the phase, **P1** = should have, **P2** = nice to have.

### Phase 0 — Foundation and decisions (≈ 4–6 weeks)
- P0: Frontend reuse is decided (D5): new frontend design; the legacy app is a feature reference only. The backup-mode removal criteria below apply to any legacy installation still in use, and the "no such endpoints" rule applies to the new backend.
- P0: New Node.js/PostgreSQL backend (D3, D4) and an OpenAPI contract informed by `api_endpoints.js`; tenant data model; auth (OTP/password, JWT/cookies); CI/CD; staging; India-region cloud.
- P0: **Remove the hidden backup billing mode completely (decision D2).** Acceptance criteria:
  - UI gesture: delete the long-press handlers (`onHold`/`timer`, `onHolddata`/`timerdata`) on the "Powered by" and copyright text in `layout/footer.jsx`.
  - Secret prompt: delete `pages/invoice/authenticatepass.jsx` and `pages/stocklist/authenticatepass.jsx`, their popups ("Hello", "dataaaa") in `pages/invoice/index.jsx` and `pages/stocklist/index.jsx`, the `/settings/verification/` call (`settingsVerificationEndPoint`), and the `now`/`addT`/`datT` flags and `setNow`/`setAddT`/`setDatT` reducers in `redux/appConfigSlcie.jsx`.
  - `/billing_backup/*` endpoints: remove `billingBackupEndPoint`, `getBackupBillGoldNumberEndPoint` and `getBackupBillSilverNumberEndPoint`, and every `now ? … : …` branch that selects them in billing. Billing always uses the single normal series. No such endpoints are implemented in the new backend.
  - Backup stock list: remove `getBackupStockListEndPoint` (`/tagging/huid-stock-list/`) and its branch in `pages/stocklist/index.jsx`.
  - Truncate call: remove `billingDrangEndPoint` (`/billing_backup/truncate-model/`) and the `DrangateTable` function.
  - Verification: a repo-wide search for `billing_backup`, `huid-stock-list`, `truncate`, `setNow`, `authenticatepass` and `Drang` returns nothing, and a CI guard keeps it that way (INV-2).
  - Legacy data: if any existing installation holds data in the backup series, do not migrate it as hidden data. Any migration decision is made with the owner's CA.
- P0: **Rebrand (decision D1):** replace "AuSales", "Ausale" and "ATTS" branding (footer, print templates, `package.json` name, favicon/logos, manifest) with the new product brand. Remove hard-coded sample values from print templates.
- P0: Implement the invoice integrity controls INV-1 to INV-6 (Section 6.10) in the core data model from day one: gapless per-branch/financial-year series, append-only audit log, DB-level delete block, credit-note-only cancellation and cancellation alerts.
- P0: Externalise configuration; fix tax and print hard-coding.
- P0: **Design-token system and branding resolution from day one** (WL-7, WL-2 minimum: app name, logo, colour tokens). Scaffold the **14 modules** with ownership rules enforced in CI and in the database (D12).
- P0: A pricing and GST calculation engine with golden test cases from 3–5 pilot shops.

### Phase 1 — MVP: single-branch retail jeweller (≈ 3–4 months)
Goal: a pilot shop runs its counter and GST compliance on the product end-to-end.
- P0 SaaS: signup and the 10-step onboarding wizard with the "Start billing" gate (6.2), tenant isolation, 3 plans with trial and online payment, owner/admin/cashier/salesperson/stock-keeper role templates with the permission matrix, audit log, automated backups and tenant export, data import (customers, items, opening tagged stock, opening balances).
- P0 Masters: company/branch, metals and purities, daily metal rates and old-metal rates, tax, item and sub-item (MC/wastage calculation types, HSN, HUID charge), customer value addition, customers/groups, cash counters.
- P0 Inventory: lot → item tag with HUID, stones and diamonds; barcode tag printing; tag details/update/duplicate; stock list; stock ledger.
- P0 Billing: estimate → bill, old-gold exchange, sales return (within policy days), split payments (cash/UPI/card/bank/cheque), discount with a minimum-price guardrail, GST-correct invoice (CGST/SGST or IGST, HSN, HUID, customer GSTIN) on A4 and thermal, cancellation, credit note.
- P0 Reports: daily sales, sales details, cash-counter collection, stock summary, tag-wise stock, daily stock (metal/purity), old purchase, GSTR-1-ready sales register and HSN summary export.
- P1: Owner dashboard (using the existing dashboard endpoints' intent), advance payments, customer credit/debit, old purchase as a standalone document, WhatsApp/SMS e-bill.
- P2: Estimation approval for below-minimum pricing.
- P0 White-label basics: tenant branding (WL-2) and versioned print templates (WL-4). P1: custom domains (WL-3) and per-tenant senders (WL-5).

### Phase 2 — Growth: chains and workshops (≈ 3 months)
- P0: Partner/reseller level and partner portal (WL-1), partner billing and white-label fees; full rebrand packs for dedicated/on-prem (WL-6).
- P0: Multi-branch (branch scoping, consolidated views), inter-branch stock transfer workflow, floors/counters/boxes and box weight verification.
- P0: Vendor purchase (new purchase), vendor payments with rate-cut (cash/metal), vendor discount and ledger, designer value addition.
- P0: Customer orders (designer assignment, attachments, advances) and repair management (issue/receipt/delivery).
- P1: Requisition approval (goods on approval), generic approval rules engine (unhide and extend), incentives and counter targets with reports, suspense accounts, purchase reports, lot report, range stock.
- P1: E-invoice integration for tenants above the threshold.

### Phase 3 — Depth and differentiation (≈ 3–4 months)
- P0: Accounting core (vouchers, day book, bank reconciliation, trial balance, P&L, balance sheet, GSTR-3B summary, Tally export).
- P1: Refinery (transfer creation/bagging, melting and purification issue/receipt, loss reconciliation).
- P1: Chit / gold-savings scheme module (enrolment, instalments, maturity redemption in billing), customer loyalty.
- P2: Owner mobile app, rate-feed integration, RFID, public API/webhooks, multi-language UI, analytics (dead stock, staff performance, margin).

---

## 10. Open questions for the owner

*(Questions on code rights, the hidden backup billing mode, the original backend, reuse strategy and offline mode are resolved. See decisions D1–D10. Architecture-specific questions are in the architecture doc, Section 19.)*

1. **Brand name:** What is the new product brand name (for the Phase 0 rebrand, domains and DLT headers)?
2. **Target segment for the MVP:** single-store retailers only, or must pilots include a multi-branch chain from day one?
3. **Pilot customers:** Which 3–5 shops (Coimbatore/Tamil Nadu?) will validate pricing formulas, print formats and the data-import format, and what software do they use today?
4. **Pricing:** Expected price points per plan (₹/month per branch or per user?) and whether you will sell through distributors or resellers.
5. **GST specifics:** Should one tenant support multiple GSTINs (multi-state)? Confirm GST treatment of making charges, old-gold purchases and job work with your CA.
6. **Scheme/chit:** Build a native gold-savings scheme module or integrate with an external provider (the code references `aupay.auss.co`)?
7. **Accounting depth:** Full books inside the product, or export to Tally/Zoho for the accountant?
8. **Suspense and "requisition approval":** confirm the exact business meaning of suspense entries and whether goods-on-approval targets retail customers, B2B shops, or both.
9. **Hardware:** Which tag/label printers, thermal printers, barcode/RFID scanners and weighing scales must be supported at launch?
10. **Languages:** Tamil and English only for the MVP, or more?
11. **Data residency and hosting:** the provider stays undecided (D7). Is an India-region data centre required for shared cloud? Which pilot customers want on-prem or dedicated hosting?
12. **Team and timeline:** in-house team size and target launch date; any fixed deadline (for example a festival season such as Akshaya Tritiya or Diwali)?
13. **Your IoT background:** Are smart-locker, RFID tray or IoT weighing-scale integrations a differentiator you want on the roadmap?
14. **White-label partners:** Do you already have reseller partners in mind? Should partners bill their own shops, or should we bill shops on the partner's behalf with a revenue share?

---

## Appendix A — Existing screen inventory (by menu)

| Menu group | Screens (route → `src/pages` folder) |
|---|---|
| Master | metal purity → metalcreate; metal rates → metalrates/dailymetal; tax → Taxs; standard → standard; rangestock → rangestock; tag → createtag; old metal rate → oldmetalrate; tax audit → taxaudit; repair type → repairtype; cash counter → cashcounter; suspense → suspense |
| Organization | organizations → organization; staff → staff; user → user |
| Infrastructure | floor counter → infrastructure; box → box; box weight verification → boxweightverification; counter target → target |
| Books | company → company; account head → accounthead; account group → accountgroup; advance payment → advancepayment; customer → customer; customer group → customergroup; incentive → incentive; credit/debit → creditdebit |
| Product Master | item master → itemmaster; sub item master → subitem |
| Purchase & Order | new purchase → newpurchase; old purchase → oldpurchase; order → order |
| Stock | lot → lot; item tag → itemtag; tag details → tagdetails; tag update → Tagupdate; duplicate tag → dublicatetag; stock list → stocklist; stock transfer → stocktransfer; stock ledger → stockledger |
| Billing | estimate billing → estimatebilling; billing → invoice; misc billing → miscissue; estimation edit → estimationedit |
| Value Addition | customer → valueadditioncustomer; designer → valueadditiondesigner |
| Approval | requisition approval / receipt → requisitionapproval; (hidden) approval type rule → approvaltype&rule; (hidden) billing & estimation approval → estimatebillingapproval |
| Vendor Management | vendor payment → newvendorpayment/vendorpayments; vendor discount → vendordiscount; vendor ledger → vendorledger |
| Repair Management | repair creation → repairmanagement |
| Refinery Management | transfer creation → transfercreation; melting issue/receipt → meltingissue/meltingreceipt; purification issue/receipt → purificationissue/purificationreceipt |
| Reports | ~30 report screens (Section 5.11) |
| Settings (header) | settings → appconfig; menu permission → menupermission; user role → userrole |
| Other | login (src/auth), home shortcuts → home, dashboard (placeholder) → dashboard, billing counter password popup → billingpopup |

## Appendix B — Print templates (`src/components/Printouts`)

| Template | Used by | Notes |
|---|---|---|
| InvoicePrint.jsx | Billing | Company header with GSTIN, today's rates, items (tag, type, weight, wastage, rate), CGST/SGST hard-coded at 1.5% each, amount in words, declaration |
| EstimationPrint.jsx | Estimate billing, estimation edit | Particulars, old items, exchange, chit, GST, net total |
| OrderReceiptPrint.jsx | Order, repair view | Advance in ₹ and grams, balance, expected delivery |
| PurchasePrint.jsx | Purchase | Contains hard-coded sample values |
| RequisitionApprovalPrint.jsx | Requisition approval | Sale-to shop, salesperson, tags |
| tagprint.jsx | Tag details | Full tag attributes |
| stockprint.jsx | Stock list | Stock table |
