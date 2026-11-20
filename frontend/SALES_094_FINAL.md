# Sales 0.9.4 final frontend handoff

Verified frozen backend commit object: `0529cc60d8b2fe2a22d0a48ac3515f2c0707506c`.
OpenAPI SHA-256: `e192ce4fd2cd613dc2280cc2482bbfe1aa73f73fff63a80d7312b1afa9f9eaff`.
Lock remains `a425ffa36d736e8ec4baf1cd8a8335a6e0c3133592081bedb07795ce8278c657`.
Supersedes active-contract and deferred-schema statements in SALES_093_INTERIM.md; older milestone documents are retained as history.

## Exact Mirage UI changes / coverage

1. Required non-null UUID/template version, locale/language/numerals/snapshot consumed from regenerated models; missing/mismatched pins or content fail closed. Pin/provenance: source-manifest.test.ts; omission matrix: print.test.tsx.
2. Resolve only exact template ID plus document version from the all-version list, including inactive rows; never row_version/newest/active or a different kind. Resolve its immutable frontend compiled archive; bind identity, kind, body_key and supported renderer. templates.test.ts; archived text/layout, missing-asset and retry tests in print.test.tsx.
3. All content reads snapshot. Envelope controls copy/stamp/cancellation-CN notes/time/paper/locale/numerals/words. No invoice/CN GET in print flow. Invoice/live balance changes, edited estimates and redeemed CNs cannot affect output. print.test.tsx frozen-content and no-GET/race tests.
4. Self-contained CN seller/GST/POS/supply type/full original invoice reference/date/total and referenced quantities; HSN/principal rate/component HSN-SAC/rates/amounts, provided tax_summary/totals/round-off/Cess are displayed, never recalculated. The original-invoice join and tax aggregation are removed. print.test.tsx QA B4 A4/A5/80mm × intra/inter, authoritative component-value case.
5. receipt_reversal requires gst_applicable=false, empty lines/reference-lines/tax_summary and zero tax. Payment reversed/store-credit/non-GST text remains; no GST table/CDN output. print.test.tsx reversal/contamination tests; existing events/list tests retained.
6. Existing copy/permission/reason/first-live restrictions retained. Never silently retries duplicate as original. contract-093-prep.test.ts and print.test.tsx error/selector tests.
7. All four requested 422 codes have plain en/ta messages; incomplete old seller GSTIN/address visibly blocks tax printing without filling live values. print.test.tsx en/ta error matrix and nullable seller tests.
8. Log displays template_id and locale; null historical pins are labelled legacy rather than guessed. print.test.tsx legacy/new log tests.
9. Backend words displayed verbatim; no print client fallback. en/ta locale/native numerals independent of UI; unsupported languages visibly fail and never browser-print. Existing font readiness/retry tests retained in print.test.tsx QA B5.

Ratchet N1 source/build manifest, N2 salesperson flag/active/branch, N3 explicit bill-only cash scope, N4 adjusted_balance_due_after and N5 authoritative per-component rounding remain covered in source-manifest.test.ts and sales-ui.test.tsx. Strict decimal serializers/transport guards, minimum-MC server display and genuine zero-piece loose validation remain covered by wire.test.ts, sales-ui.test.tsx and contract-093-prep.test.ts. No frontend non-blocking item skipped.

## Publication dependency / specification ambiguity — do not hide this

The final API supplies immutable body_key metadata (described as Handlebars source), but specifies no object-source read URL, compiled-renderer format, archive delivery convention or existing frontend template assets. No actual production/template archive bytes were supplied. The global numeral enum also admits Bengali/Gujarati, but their print fonts are not bundled: these fail explicitly rather than silently becoming Latin. The six bundled numeral systems are honoured independently of returned en/ta language/locale and their own bundled font is awaited. Do not guess a storage URL or silently interpret every arbitrary body_key as the old JSX layout.

The frontend-owned publication contract is documented in public/sales-print-templates/README.md. Exact assets live at /sales-print-templates/<uuid>/<version>.json and identify their body_key and versioned compiled renderer. sales-gst-v1 is the supported immutable compiled GST layout, with safe static heading/footer and standard/compact layout. Future rendering changes require a new renderer key/file; retain every published historical asset. Arbitrary Handlebars source is not interpreted. A publishing/compiler/recovery owner must review/compile and publish the exact original source into that archive; missing/unsupported assets fail closed and offer retry of the SAME payload, never another print POST. Unit-only assets are fixtures, not shop/demo data and not production publication.

Therefore unit/build green is NOT confirmation that real-shop exact-version assets are available or that arbitrary existing Handlebars templates render faithfully. Real template publication/recovery plus visual/native/physical QA remains an explicit acceptance dependency. No server renderer/output hash is expected, so their absence is NOT a backend contract gap. Required 0.9.4 CN snapshots close the prior B4 projection gap.

All generation/lint/typecheck/test/build runs are VPS npm scripts under with-lock.sh. Syncs use dry-run plus checksums and no force/deletions. No installs, demo-data writes, merge or deploy. Only the explicitly approved Vite frontend dist cleanup occurs. Mock response-generator changes do not change seeded records; legacy mocks without trustworthy projections/pins fail rather than invent history.
