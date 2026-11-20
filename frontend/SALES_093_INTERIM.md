# Sales 0.9.3 interim frontend

Supersedes the active-contract/preparation notes in SALES_QA_092_FOLLOWUP.md (retained as historical evidence).
Pinned backend commit object: `19c028d73051e1cb5a9e1d023268ac1be06fc489`.
OpenAPI SHA-256: `d274e77719ea185a3935f60df531fa62374e095b933b9ed7b40b7b66185049a9`.
The commit object and box/VPS backend contract were verified before regeneration; the VPS has no git metadata, so commit provenance there remains checksum-based.
Package-lock remains `a425ffa36d736e8ec4baf1cd8a8335a6e0c3133592081bedb07795ce8278c657`.
No WIP contract is used. Orval runs only on VPS, with clean:false (no VPS deletions).

## Active changes and tests

- Pin/provenance: exact SHA/full commit/version in sales-pin.json and source-manifest.test.ts; content-addressed build manifest retains the plain-tree provenance.
- Print request: generated copy enum, optional auto/duplicate, reason on every duplicate, no first-live duplicate option. Cancelled print 1 accepts reason and reprint permission, and renders server DUPLICATE/CANCELLED. contract-093-prep.test.ts, sales-ui.test.tsx, print.test.tsx.
- Print snapshots/log: required doc_cancelled and server copy determine badges independently of today's status/count. Invoice log loads on demand and shows IST/reason/version. print.test.tsx.
- Reprints omit language/numerals by default so the server retains first-print options and pinned template; explicit overrides remain possible. No active-template lookup. print.test.tsx.
- Backend Tamil words are authoritative; no production fallback/recalculation. Unsupported words languages and missing words fail closed with en/ta errors. first_print_duplicate_not_supported and pinned_print_template_unavailable also have plain messages. print.test.tsx.
- Loose pieces=0 with positive gross/net weight can issue; no fabricated piece. Tags still require >=1; old 409/422 refusals removed. contract-093-prep.test.ts, sales.test.ts, sales-ui.test.tsx.
- Strict wire scales: Money/rates 2dp and Weight 3dp string normalization plus transport guard for preview, invoice, estimates, receipts and settings. Reject numbers/short/overscale wire data; Percent/DecimalAmount remain distinct per schema. wire.test.ts.
- Minimum making charge: preview mc_amount is displayed unchanged, never recomputed from mc_value. sales-ui.test.tsx.
- Receipts use required adjusted_balance_due_after, never the deprecated alias; deliberately disagreeing alias tested on refetch. sales-ui.test.tsx N4.

## Ratchet FE follow-up retained

- B4: seller legal name/address/GSTIN/state+code, original invoice ref/date, HSN/POS and authoritative GST values on A4/A5/80mm; immutable original-invoice join validated before print POST. Receipt reversal remains Payment reversed/store credit/non-GST. print.test.tsx QA B4.
- B5: print-specific labels and response language/native numerals, Latin identifiers, bundled font readiness and retry without another print log. print.test.tsx QA B5. Interim backend supports en/ta words only; other four languages fail clearly rather than silently printing English.
- N1 immutable source/contract/lock manifest: source-manifest.test.ts.
- N2 salesperson flag/active/current-or-shared branch filtering and stale selection clearing retained: sales-ui.test.tsx N2.
- N3 bill-only shop cash-limit wording and explicit cross-invoice statutory-compliance limitation retained in en/ta: sales-ui.test.tsx N3.
- N4 present-adjusted receipt label/new field: sales-ui.test.tsx N4.
- N5 server component-rounded tax values and explicit rounding-unit note retained; no client reinterpretation: sales-ui.test.tsx N5.
No FE finding is skipped. CA/checklist reconciliation, cross-invoice policy and backend transactional acceptance remain their respective owners' work; no data mutations are used as evidence.

## Declared interim contract gaps (lead-authorised deferral to 0.9.4)

(a) Print payload has nullable template_id/template_version metadata, not required immutable template/snapshot rendering content or a version-addressable template endpoint. Keep the existing JSX template; surface metadata and never fetch the current active version for reprints. Actual template-id/version-controlled rendering/output hashes cannot be claimed. Backend first-print version pinning is consumed, not reimplemented or inferred from current templates.
(c) Credit-note print data still lacks required seller/GST/POS/original-invoice date snapshot. Retain the validated immutable original invoice join; do not use live shop/masters data. Await required self-contained payload before removing that join.
The required template/locale/numerals/CN snapshot shape will require a verified 0.9.4 re-pin/regeneration, not an invented interim extension.

Validation is VPS npm-run only under with-lock.sh; every sync has a dry run and checksum comparison. No installs, app starts, deploys, merges, deletions or demo-data changes. DOM/unit coverage is not a PDF/physical print shaping matrix or live transactional acceptance. Existing mock visual words are not backend language-acceptance evidence.
