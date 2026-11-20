# Sales module freeze (Adithya, 2026-11-09 6:53 PM IST)

Decisions: E-invoice later (S24). Part-paid bills ALLOWED (bill can be saved with balance due; Sales tracks due per bill and later payments against it; full customer ledger stays in Accounts). Customer advance redemption waits for Accounts (S31).

## Must-have (this build)
S1 Counter billing (branch, customer or quick-add by mobile, scan/type tags, running total)
S2 GST tax invoice: intra-state CGST+SGST, inter-state IGST, place of supply, seller GSTIN
S3 HSN and HUID per line, frozen on bill
S4 Line price = rate x weight + wastage + making + stones + hallmark; bill keeps rates used
S5 Per-shop making-charge GST setting (composite vs separate service)
S6 Old-gold exchange on the same bill (weight, purity, buy-back rate; per-shop old-gold setting)
S7 Line and bill discounts; below minimum / large needs discount permission
S8 Rounding: paisa lines, each tax part rounded separately, bill round-off per shop (default nearest rupee)
S9 Split payments: cash, UPI, card, bank transfer, cheque; paid vs due; PART-PAID allowed (balance due + later payment receipts against the bill)
S10 PAN above shop limit (default 2 lakh); no Aadhaar
S11 Cash limit warn/block (shop-configurable)
S12 Gapless tax-invoice series per branch per FY, server-assigned
S13 Estimates (own number, gaps ok) convertible into one invoice
S14 Sold piece -> Inventory sold in same transaction; loose stock reduced; cancel/return restores
S15 No edit/delete; cancel with reason + permission via credit note, owner alert
S16 Sales return within shop window; gapless credit note series; refund store credit or cash
S17 0% GST at billing with permission, reason, print note, audit
S18 Billing gates: online only, approved device, today's rates, onboarding GST/rates done
S19 Print A4/thermal from templates, GST breakup, HSN, HUID, amount in words; DUPLICATE reprints logged
S20 Bill list and lookup (number, date, customer, tag); read-only after issue
S21 Salesperson on bill
S22 Customer GSTIN -> B2B
S23 Loose / untagged sale by weight

## Later
S24 E-invoice IRN/QR; S25 WhatsApp/SMS e-bill (Notifications); S26 Chit redemption; S27 Loyalty; S28 Debit notes; S29 Estimate rate lock; S30 Below-minimum approval queue (Approvals)

## Moves
S31 Advances -> Accounts; S32 Customer ledger -> Accounts; S33 Standalone old-gold purchase -> Purchases; S34 Approval/try-at-home -> Approvals; S35 Orders/repairs billing -> Orders; S36 GSTR-1/HSN/daily reports -> Reports; S37 Incentive payout -> HR; S38 Ledger posting -> Accounts
