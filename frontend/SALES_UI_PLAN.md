# Sales / billing UI plan (built against contract 0.9.1)

**Author:** Mirage · Frontend  
**Date:** 9 Nov 2026 (Asia/Calcutta)  
**Status:** Sketch only — no `src/features/sales` code yet. Written against the frozen Sales scope **before** OpenAPI 0.9.0.  
**Authoritative inputs:** `/workspace/docs/freeze/sales-freeze.md` (wins on conflicts), `jewellery_saas_spec.md` §5.3–5.4 / §6.10 / D29–D35, `jewellery_saas_architecture.md` §3.2 / §4.1 Sales / §11 INV-*, `FRONTEND_PLAN.md` (routes, tokens, i18n, counter mode), inventory feature patterns (`ui.tsx`, `picker.tsx`, `labels.tsx`), data-model `100_sales.sql` + seeded `sales.*` permissions.  
**Legacy:** `outline/billing_frontend-main` is a **feature reference only** (D5). New UI must look nothing like AuSales.

---

## 0. Product decisions that shape every screen

| ID | Decision (freeze / D-rules) | UI consequence |
|----|-----------------------------|----------------|
| S9 / freeze | **Part-paid bills allowed** | Payment panel may leave a balance due; "Save bill" is not blocked when paid < net. Due tracked on the bill; later receipts against the bill. Full customer ledger → Accounts (later). |
| S31 | Customer advance redemption → Accounts | **No** advance / suspense redeem on the bill in this build. |
| S26 | Chit / loyalty later | **No** chit / gift-voucher / loyalty fields on the bill. |
| S24 | E-invoice later | No IRN/QR UI; print templates leave a slot. |
| D29 | **No offline billing** | Bill / estimate / credit-note / payment mutations disabled offline. Read-only cached bill list OK. Drop FRONTEND_PLAN "pending issue" queue for tax invoices. |
| D22 / INV-1 | Server assigns `doc_no` / `doc_date` (IST) | Client never sends numbers or dates; show "Assigned on save". |
| D35 / S15 | No edit/delete; cancel → credit note | Invoice detail is read-only; Cancel is a separate flow. |
| S18 | Gates: online, approved device, today's rates, onboarding GST/rates done | Reuse `billingState(session)` + `OfflineBanner scope="billing"` + device / setup banners already on `/counter`. |
| S5 | Making-charge GST: composite vs separate (per shop) | Live GST panel shows making under metal or as its own row from sales policy. |
| S10 / S11 | PAN above shop limit (default ₹2L); cash limit warn/block | PAN capture (last-4 display; reveal = `masters.kyc.reveal`); cash row warns/blocks per shop setting. **No Aadhaar.** |
| S14 | Sold piece → Inventory sold in same txn | Optimistic UI only; 409 if tag already sold elsewhere. |
| Calc | **Server is authoritative** | Client preview is approximate; issue/preview endpoint owns totals. Send `expected_total` when available so mismatches 422. |

Counter density: `[data-density="counter"]` — large scan box, big totals, tablet landscape ≥1366×768, keyboard + barcode wedge first.

---

## 1. Routes and permissions

Align with `FRONTEND_PLAN` §2, tightened to the freeze (no misc in this build; no receivables; no pending-issue).

### 1.1 Route map

| Route | Screen | Density | Notes |
|-------|--------|---------|-------|
| `/counter` | Counter hub (Bill / Estimate shortcuts) | counter | Keep existing stub; becomes entry, not the full bill. |
| `/counter/bill/new` | **Counter bill** (new tax invoice) | counter | `?fromEstimates=id,id` optional. |
| `/counter/bill/$invoiceId` | Issued bill (read-only) + print / cancel / pay-balance | counter / office | After issue, redirect here. |
| `/counter/estimate/new` | New estimate | counter | Same engine as bill, save as estimate. |
| `/counter/estimate/$estimateId` | Estimate view / edit / convert | counter | Draft/approved only editable. |
| `/sales` | Redirect → `/sales/invoices` | office | |
| `/sales/invoices` | **Bill list** | office | Filters in search params. |
| `/sales/invoices/$id` | Same as `/counter/bill/$id` (shared component) | office | |
| `/sales/invoices/$id/cancel` | Cancel → credit note | office | Reason + confirm. |
| `/sales/invoices/$id/pay` | Later payment against part-paid bill | office / counter | |
| `/sales/estimates` | Estimate list | office | |
| `/sales/estimates/$id` | Alias of counter estimate | office | |
| `/sales/credit-notes` | Credit note / return list | office | |
| `/sales/credit-notes/$id` | Credit note detail + print | office | |
| `/sales/returns/new` | **Sales return** (within window) | office | Pick original bill / tags. |
| `/settings/sales` | Sales policy (making GST, old-gold, return window, rounding, cash/PAN limits) | office | Owner/manager. |

**Out of this build (freeze Later / Moves):** e-invoice, WhatsApp e-bill, chit, loyalty, debit notes, estimate rate lock, below-min approval queue UI (Approvals), advances redeem, misc billing, receivables ledger.

### 1.2 Permission codes (proposed for 0.9.0)

Seeded today (`010_platform.sql`):  
`sales.invoice.issue`, `sales.invoice.cancel`, `sales.return.issue`, `sales.discount.give`, `sales.price.override_min`.  
Mocks also use `sales.estimate.create` and `print.reprint` — **confirm in 0.9.0**.

| Code | Used on | Proposed roles |
|------|---------|----------------|
| `sales.invoice.issue` | Issue bill, convert estimate→bill, later payment? | owner, manager, cashier (+ salesperson if freeze keeps issue) |
| `sales.estimate.create` *(ask)* | Save / edit estimate | owner, manager, cashier, salesperson |
| `sales.estimate.convert` *(ask)* | Convert to invoice | same as issue |
| `sales.invoice.cancel` | Cancel → CN | owner, manager |
| `sales.return.issue` | Sales return CN | owner, manager, cashier |
| `sales.discount.give` | Line / bill discount fields | owner, manager |
| `sales.price.override_min` | Below tag min / large discount | owner, manager (+ Approvals later) |
| `sales.tax.zero_rate` *(ask, S17)* | 0% GST with reason | owner |
| `sales.invoice.view` *(ask)* | Bill list / detail | all shop roles |
| `print.reprint` *(ask)* | Reprint with DUPLICATE stamp | owner, manager, cashier |
| `masters.kyc.reveal` | Show full PAN (audited reason) | owner, manager |
| `masters.customers.manage` | Quick-add customer | owner, manager (+ cashier?) |
| `inventory.stock.view` | Tag lookup on bill | already on counter roles |

Route guards: mirror inventory — `ROUTE_PERMS` + in-page `<EditGate>` / `useCan`. List routes need view; mutate buttons need action codes.

---

## 2. ASCII wireframes

### 2.1 Counter bill — `/counter/bill/new` (primary)

```
┌─ Top bar: Branch · Counter · Rates ticker · Online pill · ⌘K ──────────────┐
│ [⚠ Offline: billing unavailable]  or  [⚠ Today's rates missing — Rates]    │
│ [Device not approved]  [Finish shop setup to start billing]                 │
├──────────────────────────────────────────────┬─────────────────────────────┤
│ CUSTOMER                                     │ LIVE TOTALS (sticky)         │
│ Mobile [____________] 🔍  or Quick-add       │ Metal          ₹__.__       │
│ Name · GSTIN (B2B) · State → GST type        │ Wastage        ₹__.__       │
│ Salesperson [v]                              │ Making         ₹__.__       │
│                                              │ Stones         ₹__.__       │
│ SCAN / TAG  (always focused)                 │ Hallmark       ₹__.__       │
│ [ TAG / HUID / barcode ____________ ] ⏎      │ ─────────────               │
│ hint: Tag number, HUID or design code…       │ Taxable        ₹__.__       │
│                                              │ CGST 1.5%      ₹__.__       │
│ Lines                                        │ SGST 1.5%      ₹__.__       │
│ ┌──────────────────────────────────────────┐ │ (or IGST …)                  │
│ │ # │ Tag │ Item │ Net g │ HUID │ Rate │… │ ₹│ Old gold     −₹__.__       │
│ │ 1 │ DEMO-RSP-01 │ Bangle 22K │ 3.200 │…  │ │ Discount      −₹__.__       │
│ │   │ MC ₹450/g · wastage 8.5% · stones …  │ │ Round-off      ₹__.__       │
│ └──────────────────────────────────────────┘ │ ═══════════════════         │
│ [+ Loose / by weight]  [+ Old gold F2]       │ PAYABLE      ₹1,23,456.00   │
│ [Discount…]  [0% GST…]                       │ Paid           ₹__.__       │
│                                              │ Due            ₹__.__       │
│                                              │ [PART-PAID] if due > 0      │
├──────────────────────────────────────────────┴─────────────────────────────┤
│ PAYMENTS (F1)  Cash [  ] UPI [  ] Card [  ] Bank [  ] Cheque [  ]          │
│ Cash warn/block · PAN if ≥ limit [ last4 **** · Show ]                     │
│ [ Save estimate Ctrl+E ]  [ ISSUE BILL Ctrl+S ]  [ Clear Esc ]             │
└────────────────────────────────────────────────────────────────────────────┘
```

Tablet: totals panel collapses under lines as a sticky footer strip with PAYABLE in ~28–32 px tabular nums.

### 2.2 Old-gold exchange panel (sheet / drawer, F2)

```
┌─ Old gold on this bill ─────────────────────────────────────┐
│ Purity [22K v]  Gross [___.___] Less/dust [___.___]         │
│ Net (auto) · Touch % · Fine wt · Buy-back rate (today)      │
│ Amount (preview) ₹__.__     [Add]                           │
│ List of OG lines · total deducted from payable              │
│ Excess handling note (shop policy: cash back / adjust / …)  │
└─────────────────────────────────────────────────────────────┘
```

### 2.3 Estimate — `/counter/estimate/new` & convert

Same shell as bill. Banner: **"Estimate — not a tax invoice"**.  
Actions: Save estimate · Print estimate · **Convert to bill** (loads `/counter/bill/new?fromEstimates=`).  
Gaps in estimate numbers OK; show server-assigned estimate no after save.

### 2.4 Bill list — `/sales/invoices`

```
┌─ Bills ─────────────────────────────────────────────────────┐
│ Search [bill no / mobile / tag / customer]  Date [from–to]  │
│ Status [All|Issued|Part-paid|Cancelled]  Branch [v]         │
├─────┬──────────┬────────┬──────────┬────────┬──────┬────────┤
│ Date│ Bill no  │Customer│ Taxable  │ Paid   │ Due  │ Status │
│ …   │ CBE-…001 │ Ravi   │ ₹12,300  │ ₹10,000│₹2,300│Part-pd │
└─────┴──────────┴────────┴──────────┴────────┴──────┴────────┘
│ Empty: "No bills yet. Open Counter to make the first one."  │
└─────────────────────────────────────────────────────────────┘
```

### 2.5 Issued bill detail — `/counter/bill/$id`

Read-only lines + GST breakup + payments + due.  
Actions: **Print** (A4 / thermal) · **Reprint** (DUPLICATE, logged) · **Pay balance** · **Cancel** (perm) · **Return**.

### 2.6 Cancel → credit note — `/sales/invoices/$id/cancel`

```
Cancel bill CBE-2627-00041 — ₹1,23,456.00
Reason (required, ≥3 chars) [________________]
Refund: ○ Store credit  ○ Cash  ○ Reverse payments
[ Owner will be alerted ]     [ Cancel bill ]  [ Back ]
```

### 2.7 Sales return — `/sales/returns/new`

Pick original bill → select lines/tags still within `return_window_days` → settlement (store credit / cash per policy) → issue credit note (gapless CN series).

### 2.8 Credit note detail + list

Office tables; print A4/thermal; link back to original bill; no edit.

### 2.9 Print dialog (shared)

```
Print  ○ A4 tax invoice  ○ Thermal 80mm
Language [Shop default v]  Numerals [Latin v]
[ Preview ]  [ Print ]     Reprint → reason + DUPLICATE stamp
```

Uses versioned tenant templates (WL-4); amount in words from `packages/domain`.

---

## 3. Interaction flows & keyboard shortcuts

### 3.1 Happy path — tagged sale

1. Counter opens → scan box focused.  
2. Scan / type tag → Enter → lookup (`GET tag-lookup` / sellable check) → line append; focus returns to scan.  
3. Optional: customer by mobile (typeahead) or quick-add. GST type from place of supply vs seller GSTIN.  
4. Optional: old gold (F2), discounts, loose line.  
5. F1 → payments; amounts auto-fill remaining. Part-pay allowed.  
6. Ctrl+S → `POST /v1/sales/invoices` with `Idempotency-Key` + optional `expected_total` → redirect to issued bill → print dialog.

### 3.2 Estimate → bill

Save estimate → later open → **Convert** → bill draft prefilled from estimate payload → staff may adjust → Issue (consumes estimate → `billed`).

### 3.3 Keyboard map (counter mode)

| Key | Action |
|-----|--------|
| Focus default | Scan / tag input |
| Enter (in scan) | Add tag |
| F1 | Open / focus payments |
| F2 | Old-gold panel |
| F3 | Customer mobile |
| F4 | Discount |
| Ctrl+S | Issue bill (or Convert+issue when from estimate) |
| Ctrl+E | Save estimate |
| Ctrl+P | Print (on issued doc) |
| Esc | Close sheet / clear scan warn |
| ↑↓ | Move line selection; Del removes selected line |

Legacy Ctrl+G "toggle GST" is **dropped** (INV-2 / D2 — GST always on). Remap intent: Ctrl+G opens GST breakup detail.

Scanner: keyboard-wedge (chars + Enter). Camera scan is secondary (tablet).

### 3.4 Conflict handling (issue)

| HTTP | Code (expected) | UI |
|------|-----------------|----|
| 409 | `tag_sold` / `tag_not_sellable` | Remove/highlight line; toast |
| 409 | `rates_stale` / `rates_missing` | Block + link to Rates |
| 409 | `already_printed` N/A | — |
| 412 | `version_mismatch` (estimate convert) | Reload estimate |
| 422 | `validation_failed` / `expected_total_mismatch` | Field errors; refresh preview |
| 422 | `pan_required` / `cash_limit` | Inline on payment |
| 403 | missing perm / device | Gate banners |
| 401 | session | Re-login |

Idempotency: one key per attempt (`useAttemptKey` pattern from labels); reset when lines/payments change; retry same key on network fail.

---

## 4. States

| State | Behaviour |
|-------|-----------|
| **Empty bill** | No lines: Issue disabled; illustration + "Scan a tag to start". |
| **Loading lookup** | Scan spinner; queue rapid scans. |
| **Loading issue** | Buttons disabled; "Saving bill…" |
| **Error** | `ErrorText` / problem+json → `error.<code>` i18n (inventory pattern). |
| **Offline / PWA** | Mutations disabled; `OfflineBanner scope="billing"`; bill list may show cached reads; **no** provisional receipts (D29). |
| **Gates** | Setup / device / rates / online — same as current `/counter` stub. |
| **412** | Reload versioned resource; keep draft lines in memory where safe. |
| **409** | Conflict card on the offending line or payment. |
| **Part-paid** | Badge on list + detail; Pay balance CTA. |
| **Cancelled** | Watermark; link to credit note; no pay/print tax copy except cancelled stamp rules (confirm). |

---

## 5. Components to build (reuse inventory primitives)

| Component | Reuse / new | Role |
|-----------|-------------|------|
| `SalesNav` + `SalesPage` | Like `InventoryNav` / `InvPage` | Sub-nav: Bills, Estimates, Credit notes, Returns, Settings |
| `TagScanField` | Extend `TagPicker` | Single-add, sellable check, duplicate-in-bill warn |
| `BillLineTable` | New (TanStack Table) | Lines with HUID, weights, MC, wastage, stones, HSN |
| `LooseLineForm` | New | Untagged sale by weight (S23) |
| `GstBreakupPanel` | New | Live CGST/SGST/IGST + component rows (metal/making/…) |
| `OldGoldEditor` | New | Weights, purity, rate snapshot |
| `PaymentSplit` | New | Modes from `masters.payment_mode`; cash/PAN guards |
| `CustomerBillHeader` | New + masters customer typeahead | Mobile search, quick-add, GSTIN → B2B |
| `PanCapture` | New | last4 + audited reveal (`masters.kyc.reveal`) |
| `DiscountFields` | New | Gated by `sales.discount.give` / override_min |
| `BillTotals` | New | Big payable; part-paid badge |
| `EstimateBanner` | New | Not-a-tax-invoice |
| `PrintInvoiceDialog` | Extend `PrintPreview` | A4/thermal, language, DUPLICATE |
| `BillFilters` | Like inventory list search | q, dates, status, branch |
| `CancelBillForm` / `ReturnForm` | New | Reason ≥3 (`MIN_TEXT`), settlement |
| `NotReadyOr` | Reuse | 501/404 until 0.9.0 fully routed |
| Formatters | `formatINR`, `formatWeight`, `MoneyInput`, `WeightInput` | en-IN |
| Attempt key | `useAttemptKey` | Issue, CN, pay, reprint |

Folder (when coding starts): `src/features/sales/{ui,bill,estimate,payments,old-gold,returns,print,api,hooks,types}.tsx` + routes under `src/routes/counter*` / `sales*`. Replace the thin stub in `routes/counter.tsx`.

---

## 6. Calculation notes (preview vs server)

**Server authoritative** (architecture §8, freeze S4/S8, existing Orval note on `issueInvoice`):

- Line: `rate × weight + wastage + making + stones + hallmark` (snapshots rate, MC, wastage, HSN, HUID).  
- Tax: per line; each of CGST / SGST / IGST / cess rounded separately to 0.01 half-up (D34). Making may be composite or separate (S5 / `SalesPolicy.making_gst_treatment`).  
- Bill: sum lines − discounts − old gold + round-off (shop default nearest rupee, S8).  
- `net_payable = invoice_total − old_metal` (model); `paid + balance_due = net_payable`.  
- `doc_no` / `doc_seq` / `doc_date` server-only.  

**Client preview only:**

- Debounced `POST /v1/sales/preview` *(ask Ironhide)* or local decimal.js mirror in `packages/domain` for snappy UI — must never diverge silently; on Issue send `expected_total` and handle 422 mismatch by applying server figures.  
- Do **not** ship a second tax engine that can issue.  

**Stock:** Sales calls Inventory inside the issue transaction (S14); UI treats tags as sold only after 2xx.

---

## 7. i18n keys outline (`sales.*`, en-IN + ta-IN first)

```
sales.nav / sales.nav.bills|estimates|creditNotes|returns|settings
sales.bill.title|new|issued|partPaid|cancelled
sales.bill.scan|scanHint|addLoose|lines|empty
sales.bill.customer|quickAdd|salesperson|b2b
sales.bill.issue|saveEstimate|clear|payable|paid|due
sales.gst.taxable|cgst|sgst|igst|breakup|placeOfSupply
sales.line.metal|wastage|making|stones|hallmark|huid|hsn|discount
sales.oldGold.title|gross|less|net|touch|rate|amount|excess
sales.pay.title|cash|upi|card|bank|cheque|addRow|balance
sales.pay.cashWarn|cashBlock|panRequired|panLast4|panReveal
sales.estimate.title|banner|convert|validUntil
sales.list.search|status|empty|due
sales.cancel.title|reason|refundStore|refundCash|alertOwner
sales.return.title|window|pickBill|settlement
sales.creditNote.title|print
sales.print.a4|thermal|duplicate|language|preview
sales.gate.offline|rates|device|setup
sales.error.<code>   # map problem+json codes
```

Plain-language labels (shop-owner words): "Bill", "Making charge", "Old gold", "Amount due", not "invoice_line_tax.component".

Tamil (`ta-IN`) required to ship Phase 1 Sales; expect ~30–40% longer strings — flexible totals column.

---

## 8. Assumptions (until 0.9.0)

1. Freeze overrides FRONTEND_PLAN offline queue and advance/chit on the bill.  
2. One unified bill engine for estimate + invoice (no four legacy copies).  
3. Existing stub `POST /v1/sales/invoices` grows into full 0.9.0; preview endpoint likely added.  
4. `SalesPolicy` (already in OpenAPI settings) drives making GST, old-gold basis/excess, return window, CN rounding.  
5. Payment modes come from `masters.payment_mode` (kind → cash|upi|…).  
6. Part-paid later receipts are Sales endpoints (not Accounts ledger).  
7. Salesperson on bill = `hr.staff` / masters staff with `is_salesperson`.  
8. Loose sale (S23) is a line without `tag_id` (item + purity + weight).  
9. Reprint always audited; first print vs reprint mirrors inventory labels pattern.  
10. No hard-coded brand colours; tokens only; `formatINR` only for money.

---

## 9. Ironhide's answers (contract 0.9.0 → 0.9.1, built against 0.9.1)

Pinned contract: **0.9.1**, backend commit `1ff86a5`, `backend.openapi.yaml` sha256 `9c2687d29e3f5f8ae97f80bce7c96b85c31841d11e372e7d32db742c5c89825e`.
Sales routes are contract-only on dev (404): every screen shows "Billing isn't switched on yet" (`isSalesOff`) and is tested with stubbed fetch / MSW only.

| # | Question | Answer (as built) |
|---|----------|-------------------|
| 1 | Preview | `POST /v1/sales/preview`, same body as issue, returns `BillComputation`, no writes, **no** Idempotency-Key. Debounced 350 ms; server figures only. Needs customer + salesperson (contract requires them), so before that the screen shows a rough total from the `/sellable` answers. |
| 2 | Permissions | Existing: `sales.invoice.issue`, `sales.invoice.cancel`, `sales.return.issue`, `sales.discount.give`, `sales.price.override_min`. New: `sales.invoice.view`, `sales.estimate.create`, `sales.payment.receive`, `sales.invoice.reprint`, `sales.invoice.zero_gst`; 0.9.1 adds `sales.invoice.credit_sale`, `sales.old_gold.rate_override`. Convert needs issue. (`SALES` in `lib/permissions.ts`.) |
| 3 | Payments | `POST /invoices/{id}/payments {tenders[]}` + Idempotency-Key; many receipts allowed. 422 `overpayment`, 409 `invoice_cancelled` / `invoice_fully_paid`. |
| 4 | Estimates | CRUD; PUT + cancel with If-Match; statuses draft / billed / cancelled / expired; convert via `estimates[{id,version}]` on `POST /invoices` (412 when stale). `EST-{branch}-{yyyy}-{seq:5}`; valid to end of day; merge ≤ 10, same branch + customer. |
| 5 | Credit notes | kind `cancellation` (whole bill, `/cancellation`) or `sales_return` (`/returns` with `line_ids`); reason 5–500; `refund_mode`; optional restock; whole lines only. |
| 6 | Return errors | 422 `return_window_expired`, 409 `line_already_returned`, 422 `line_not_on_invoice`. Window shown as a hint from `return_window_days`. |
| 7 | Zero GST | `zero_gst {reason 5–200}` needs `sales.invoice.zero_gst`, else 403 `zero_gst_not_allowed`. |
| 8 | PAN / cash | PAN write-only (`pan_on_file`, `pan_last4` only); 422 `pan_required`. Cash limit 422 `cash_limit_exceeded` or `warnings[]`; preview `requirements` carries both. 0.9.1: cash counts at issue **plus** later payments, triggers at ≥ limit (default ₹2,00,000, per shop), blocks. |
| 9 | Old gold | `OldGoldInput {purity_id, gross_wt, less_wt?, touch_pct?, description?}`; 422 `old_gold_exceeds_bill`; `old_gold_excess_payout` cash / bank_transfer. 0.9.1: optional `rate_override` + `override_reason` (5–200) as a pair, needs `sales.old_gold.rate_override` (403 otherwise); priced rows show `server_rate`, `rate_per_g`, `overridden`, `override_reason` → "Rate changed from ₹X — reason". |
| 10 | Loose lines | 409 `insufficient_loose_stock` (logic + request builder done; loose-line entry UI is milestone 2). |
| 11 | Sellable | 409 `tag_sold`, `tag_reserved`, `tag_on_approval`, `tag_in_transit`, `tag_in_repair`, `tag_not_sellable`, `tag_other_branch`, `huid_missing`; 422 `duplicate_tag_in_bill`; unknown tag 404 → "No piece with that number". All have en + ta messages (`error.<code>`). |
| 12 | Idempotency | Key on issue, payments, cancellation, returns, estimate create and every print (`useAttemptKey`); If-Match on estimate PUT and cancel. |
| 13 | Print | Server logs the print and returns `SalesPrintDocument`; client renders (`SalesPrintView`) and calls `printer.print()` (stubbed in tests). First print original; later prints DUPLICATE need `sales.invoice.reprint` + reason 3–200. doc types invoice / credit_note / estimate; paper A4 / A5 / thermal 80 mm via named `@page` rules. Cancelled bills print only as a duplicate stamped CANCELLED. |
| 14 | Bill list filters | q, doc_no, from, to, customer_id, tag_id, tag_no, salesperson_id, status, payment_status, supply_type, limit, cursor (empty filters dropped; from > to swapped). |
| 15 | Salesperson / counter | `salesperson_id` required (remembered per device); `cash_counter_id` optional. |
| 16 | Tax parts | Each line has `tax_parts[]`; `tax_summary` by HSN + rate → GST breakup table. |
| 17 | expected_total | Optional; sent = previewed `net_payable`. 422 `expected_total_mismatch` → re-preview, show the new total, ask to confirm. |
| 18 | Extras | Store credit = `credit_note` tender; 0.9.1 typed 409 `customer_phone_exists` carries `existing_customer {customer_id, name}` → "Use this customer". |
| 0.9.1 | Credit sale | Fully unpaid bill needs `sales.invoice.credit_sale` (403 `credit_sale_not_allowed`); preview `requirements.credit_sale_permission`. The screen explains it up front and blocks Issue; part-paid needs nothing extra. |
| 0.9.1 | Making service rate | 422 `making_service_rate_not_set` on preview / issue / estimates (and readiness gate `making_service_rate`): blocking message; owners get a link to shop rules. |
| 0.9.1 | Proposals | All earlier * proposals approved as **per-shop settings** — read from `GET /v1/sales/settings`, never hard-coded (cash limit + mode, PAN threshold, discount %, estimate validity, default paper, print language, return window, refund default, old-gold excess handling). Only `MAX_ESTIMATE_MERGE = 10` mirrors the contract's `maxItems`. |

**0.9.2 resolution of the four earlier contract gaps:**
- Named `RefundMode` / `ReturnRefundMode` (and shared policy enums) remove the Orval collision; the input transformer is gone.
- `PreviewBillRequest.mode=estimate` accepts branch + lines alone; no customer / salesperson needed for live totals.
- `Estimate.print_count` / `last_printed_at` now drive duplicate reasons; print history appears on all three detail pages in IST.
- `GET/PATCH /v1/sales/settings` is the single Sales settings source. Owner settings no longer use the deprecated sales-policy endpoint.

**0.9.2 contract gap to confirm:** a cancelled invoice that was never printed returns 409 `cancelled_invoice_original_unavailable`, even with a
reprint reason (backend integration test covers this). `SalesPrintRequest` has no copy selector. Thus there is no documented way to request
its duplicate; the UI labels the action as duplicate, requires a reason, and shows the refusal without attempting an original or a bypass.

### 9.1 Milestone 2 (built 9 Nov 2026)

| Area | Behaviour |
|------|-----------|
| Loose line | "Add untagged piece" on bill and estimate: item, purity, pieces (≥1), gross, stone, net (empty = gross; net ≤ gross), description, counter and tray (branch-limited). Priced lines match by position (`line_no`); 409 `insufficient_loose_stock` is shown in plain words and highlights the line. |
| Restock | Return and cancel forms: "Put back to counter" + tray (active, same branch). Empty = server default (where each piece was sold from); `restock` is omitted. |
| Line discount | Discount ₹ per line, hidden without `sales.discount.give`. States: large (warning only, > `large_discount_pct`), above limit (> `discount_max_pct`, needs `sales.price.override_min` + reason 3–200), more than the line value / not a number (blocks). |
| B2B / place of supply | GSTIN (15, format-checked) → B2B; state code auto-filled from the GSTIN, mismatch blocks. B2B place of supply is locked to the GSTIN state (never sent); B2C may send another 2-digit state code (`place_of_supply`). |
| Visual check | VPS-local Vite dev server with MSW (`mocks/sales.ts`), headless Playwright 1366×900 + 1024×768 (en and ta). Fixes: two-column bill layout from `xl` (single column on tablets), payment rows stack amount under the mode, no-wrap money cells, padded list tables, shared lines table (loose chip) on bill / estimate detail, credit-note lines, print totals block + seller address, compact thermal lines and GST block. |

### 9.2 Contract 0.9.2 (backend 09f9398)

Pin: `22137063ba690ea9f416e260ba503bc685779eff8e87d759348e733110476c13`. Regenerated on VPS with no installs. Orval `clean:false`
retains orphan generated files because VPS deletion is forbidden; the barrel and app consumers use the new named schemas, not the old aliases.

- Live preview explicitly sends `mode=invoice|estimate`; PAN, cash-limit and credit-sale requirements are informational on estimates.
- The zero-piece loose line is preserved in preview / estimates, but invoice issue blocks and highlights it. The loose line has a piece-count
  input so it can be corrected; 422 `weight_only_loose_sale_not_supported` and 409 `cancelled_invoice_original_unavailable` have en/ta messages.
- Original / duplicate is decided from `print_count`; **all** duplicates require a 3–200 character reason, including estimates and credit notes.
  All details show count + RFC3339 last-print timestamp converted to IST.
- `/sales/settings` (legacy `/settings/rules` uses the same screen): owner + `sales.settings.edit`; all writable per-shop values, including
  making_service_rate, use PATCH with If-Match from `version` (including 0 for never-saved defaults). Only changed writable fields are sent;
  money / rates are normalised, 412 preserves the draft and requires reload. PATCH's full response replaces the settings caches. Tax round-off
  and print language/numerals remain read-only here. Both readiness and problem `settings_path` map to the new route (unknown = safe fallback).
- Payment receipt reversal: `sales.receipt.reverse`, reason 5–200, explicit confirmation, Idempotency-Key; reversals / reversed receipts cannot be
  reversed again. The new returned store-credit note remains visible after receipt refresh.
- `receipt_reversal` credit-note kind / owner alert type / topic `alert.receipt_reversal` = **Payment reversed** (en/ta). Its amount is
  `store_credit_amount`, not a sales return. The kind filter includes it. No alert or GST/CDN report UI exists yet; shared label mapping and
  `isGstCreditNote` explicitly exclude it from future GST/CDN consumers. Its print title is Payment reversed, with no GST breakup.
- The counter uses only server-priced line allocations; no client bill-discount split. The dev mock uses largest fractional remainder,
  with ties to the first line. Return default now preserves cash / bank_transfer / store_credit (no legacy refund alias).
- Tamil taxable-value label shortened to **வரி மதிப்பு** for narrow GST panels.
- Tests: estimate preview without customer/salesperson, zero-piece preservation and issue block, duplicate reasons, ETag 0/cache replacement,
  412 reload flow, owner gate and 404-off state, settings-path mapping, receipt permissions / reversal confirmation and result, credit kind filter /
  amount / GST exclusion, RFC3339 → IST history, and both refusal locations.

## 10. Build order (when 0.9.0 exists)

1. Pin OpenAPI → Orval → `features/sales/api.ts` wrappers.  
2. Sales shell nav + bill list (read).  
3. Counter bill: scan, lines, preview totals, customer, issue, print.  
4. Payments split + part-paid + pay-balance.  
5. Old gold + discounts + loose line.  
6. Estimates + convert.  
7. Cancel CN + returns + CN list/detail.  
8. PAN/cash/0% GST gates + settings/sales policy screen.  
9. en-IN + ta-IN catalogues; Playwright counter path.

---

## 11. Explicit non-goals this plan

- Anything resembling AuSales layout/CSS.  
- Offline tax-invoice queue.  
- Advances, chit, loyalty, e-invoice, WhatsApp e-bill, debit notes, misc billing, receivables (Accounts).  
- Direct DB or VPS work from this document.  
- Implementing screens under `src/` until contract 0.9.0 is agreed.
