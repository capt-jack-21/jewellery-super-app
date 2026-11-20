# Sales 0.9.2 frontend QA follow-up

Target remains contract **0.9.2**, SHA-256 `22137063ba690ea9f416e260ba503bc685779eff8e87d759348e733110476c13`.
QA reviewed backend target `09f939859b8f7a76878d3265c0c84574ed1871b7`; neither the current nor deployed VPS backend commit is inferred from that target. Frontend is a plain source tree, not a git revision.

## B4 — GST credit-note print

- Resolve credit note and its immutable original invoice before POSTing a print. Validate matching invoice ID/number/branch, seller identity/GST address and line/tax-part snapshots. Missing/mismatched particulars fail closed before a print-log write.
- Shared seller block: legal name, full supplied address, GSTIN, state name/code. CN also prints original invoice reference/date, supply state, original line HSN/HUID, and note taxable/CGST-SGST or IGST/cess/rounding values.
- Whole-line returns reuse original invoice tax parts; never consult live masters/rates or allocate new taxes. Match their sums against the note's authoritative tax values.
- Receipt reversal remains **Payment reversed**, uses store credit given back, and has no GST or returned-goods table.
- Coverage: `print.test.tsx`, `QA B4` (A4/A5/80mm × intra/inter; missing/mismatched snapshots; fetch-before-POST; reversal).
- Contract limitation: the 0.9.2 CN projection is not self-contained. Original invoice read access and its saved address/GST snapshot are required. A self-contained immutable CN print projection remains a backend contract improvement.

## B5 — print language, numerals, fonts, words

- Detail screens seed per-print language/numerals from SalesSettings, independently of UI locale; requests include these options explicitly. Renderer uses response language/numerals in a print-only Intl provider.
- Six bundled script fonts/print labels; Latin/native quantities, weights, prices, tax percentages, dates and print counts. GSTIN/HSN/HUID/tag/document numbers and state codes stay Latin.
- Await selected font CSS, 400/600 faces and FontFaceSet.ready after the print DOM is committed. Failure is visible; browser-print retry does not create another print log.
- `salesPrintWords` is the only fallback boundary: a nonempty backend amount_in_words is authoritative; only a missing/empty field uses the existing local helper. Replace the fallback boundary when the final 0.9.3 words shape is approved.
- Coverage: `print.test.tsx`, `QA B5` (12 language/numeral DOM renders, inverted UI locale, options request, backend words/fallback, font wait/failure/retry).
- These are text/DOM unit tests, not PDF/physical shaping acceptance. Backend 0.9.2 words support is English-only; non-English correctness of its populated field is a backend gap, not silently overridden here. hi/te/kn/ml wording still needs native-speaker acceptance.

## Non-blocking findings — frontend work and remaining owners

| Item | Frontend correction | Unit coverage | Deliberately not changed |
|---|---|---|---|
| N1 provenance | Content-addressed `dist/source-manifest.<source-tree-sha>.json` plus discoverable `source-manifest.json` and index link. Includes every source path/hash, exact tree, lock and pinned contract SHA, explicit null frontend commit, and QA-only backend target. Build fails if the pin drifts. | `src/lib/source-manifest.test.ts` (deterministic bytes/paths, exact contract/lock and no false commit claim) | No deploy/publish; no invented VPS git revision. Coordinator must archive/reference this immutable build and prevent concurrent edits during future QA. |
| N2 salesperson | Active + salesperson flag + matching/shared branch filtering; clear a stale ineligible remembered/prefilled selection. | `sales-ui.test.tsx`, `N2` | Direct-API eligibility enforcement remains backend work. |
| N3 cash scope | Replace legal-limit claims with the shop's bill limit; owner settings explicitly explain no cross-bill/person/day/event check or complete s.269ST certification. en/ta. | `sales-ui.test.tsx`, `N3` | CA policy and shared cross-invoice checks are not frontend rules to invent. |
| N4 receipt balance | Label balance_due_after as balance after this receipt **adjusted for later returns**, not an immutable as-at receipt balance. en/ta. | `sales-ui.test.tsx`, `N4` (server value changes after refetch while receipt number stays the same) | No synthetic historical reconstruction or backend accounting/data changes. |
| N5 rounding | Show authoritative server values and state component-per-line rounding. The 102.70 fixture is not recomputed as 102.69. en/ta. | `sales-ui.test.tsx`, `N5` | CA/checklist/backend reconciliation of the two acceptance interpretations remains outstanding; neither is falsely marked equivalent. |

No FE non-blocking item was skipped. Backend B1/B2/B3/B6/B7/B8 and backend portions of N1–N5 are not claimed fixed by this frontend pass.

## Minimal 0.9.3 prep — unwired

`contract-093-prep.ts` and its tests isolate planned request copy auto/duplicate + reason, server copy/doc_cancelled badges and zero-piece/positive-weight loose validation. No live screen/API imports this module. Active 0.9.2 refusals and weight-only issue block stay in place. The work-in-progress 6d1f5c97 contract is not pinned or generated.

When the final SHA arrives:
1. Verify final contract on box/VPS, explicitly update `contracts/backend.openapi.yaml`, `contracts/sales-pin.json` and the provenance test pin.
2. Regenerate on VPS (no installs; preserve no-deletions policy), return generated bytes to box and inspect the exact diff.
3. Wire the isolated request/copy/cancelled helpers; consume the documented server flags on response/log rows. Retire cancelled_invoice_original_unavailable handling only with the final contract.
4. Remove the live weight_only loose issue blocker/refusal; keep tag piece validation. Preview/estimates already retain zero without coercion.
5. Check final words and immutable CN projection shapes; adapt only to the final published schema. Backend must have validated its migration/first-cancelled-print and stock rules.
6. Dry-run every sync, verify parity and repeat the full VPS suite. Do not infer readiness from the WIP SHA or deploy anything.
