# Orders & Repairs module freeze (Adithya, approved 2026-11-17 IST)

Decisions:
- Migration numbering from now on: 5-digit prefix, new files only (01000_...). Old names stay valid. The runner and apply.sh get one compatibility rule, tested fresh and upgrade on a throwaway DB. APPLIED.sha256 is kept current.
- Advances: a minimal advance (money or metal) is taken for an order through a Sales function that Orders calls (the advance table lives in the sales schema and only the Sales role changes its balance). Accounts takes it over later. Metal advances hold a fine-gram balance (new gram balance column, new migration).
- Order piece: when the finished piece is received and tagged it is reserved for that customer's order.
- Rate lock: simple. One locked rate per gram on the order. No expiry, gram cap or minimum advance in v1.
- Repair loss: per-shop tolerance that BLOCKS the receipt when exceeded. Override needs the new permission orders.repair.loss_override.
- Sales changes needed by O6/O2 (order_id on the invoice, locked rate, advance tender) deploy together with Orders in one release (one contract bump).
- The unfinished receipt-print Dialog fix is finished with a regression test and ships in the same release.
- Old gold on repair advances: later.

## Must-have (this build)
O0  Prerequisites: new migration numbering; new migration adding version columns, missing foreign keys (repair branch) and a tag link on repair lines; gram balance column on advances; new permissions; wire @jw/mod-orders into app.module.ts and apps/api/package.json; CI guard for orders_writer
O1  Create order: customer (lookup or quick-add), branch, priority, due date, lines (item, purity, pieces, approx weight, size, stones, design notes, photos via /v1/files). Number ORD-{BRANCH}-{FY}-{SEQ:5}
O2  Order advance in money or metal (fine-gram balance) with optional locked rate per gram; receipt print
O3  Assign order lines to a vendor with a due date. Metal issued to the vendor is a note on the line only until Accounts exists
O4  Status flow open > in_production > ready > delivered; cancel with reason and permission, advance refunded or turned into store credit
O5  Receive finished piece through Inventory: lot (entry type order_receipt), tag it, reserve it for the order
O6  Deliver and bill through Sales at the locked rate with the advance applied as a tender; tag reserved > sold in the same transaction; order delivered (Sales minor release)
O7  Create repair: customer, items with weights and photos, repair type with min/max charge limits, estimate, due date, optional advance. Number REP-{BRANCH}-{FY}-{SEQ:5}. Customer receipt print (proof of custody)
O8  Issue repair to a vendor and receive back; received weight checked against the per-shop tolerance (blocks; override permission)
O9  Repair delivery and billing as a Sales service line (repair type SAC, GST per service rule); shop-own piece goes repair <-> in_stock via Inventory
O10 Lists and search by number, customer, phone, status, due date, overdue; due-today and overdue card
O11 Prints: order receipt, repair receipt, vendor issue slip (A4, A5, 80 mm), versioned templates
O12 Settings: number formats, default due days, repair loss tolerance, advance required or not
O13 Repair types API under Masters (/v1/masters/repair-types)
O14 Finish the receipt-print Dialog fix (Sales front end) with a regression test

## Later
WhatsApp/SMS ready messages (Notifications); production Kanban; karigar job cards (manufacturing, D13); customer design-photo approval; diamond lines, schemes, vouchers and card/cheque detail inside repairs; old gold on repair advances; order cancellation through the Approvals engine; rate lock expiry, gram cap, minimum advance; NB-4 receipt print-log endpoint (needs a manual rebase)

## Moves
Customer ledger and ledger posting of advances > Accounts; vendor metal issue/receipt accounts > Accounts

## Still to settle at contract stage
Rate lock behaviour on the bill: always use the locked rate, or the lower of locked and today's rate (shop setting, default to be confirmed)
