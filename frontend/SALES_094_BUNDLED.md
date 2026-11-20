# Sales bundled print families (supersedes SALES_094_FINAL archive dependency)

No template fetch, external asset store, storage URL or Handlebars interpreter/dependency. Key is the EXISTING seeded body_key plus document template_version. A family covers A4/A5/thermal_80mm × en-IN/ta-IN; locale/numerals/copy/stamp/paper/words come from the print envelope, content only from snapshot. Template engine is informational. Old unknown IDs/keys/versions fail closed, never select current/newest.

## Verified source extraction

At frozen backend commit0529cc60, the print payload has template_id/version but NO body_key. Backend integration fixture adds tpl/test/credit-note.hbs@1 with a generated UUID. External data-model tests/seed.sql has tpl/platform/invoice.hbs@1, receipt.hbs@1, estimate.hbs@1 and tpl/t1/invoice-v1.hbs@1, invoice-v2.hbs@2. Their UUIDs are generated at insertion, paper A4/language en/numerals latin default. No fixed ID mapping can be inferred from those old seeds. Box/VPS seed and frozen backend source checksums were verified, without reading credentials or touching any data.

Per the subsequent lead decision, Perceptor migration998_print_template_platform_defaults.sql publishes four fixed UUIDs, allv1, paper A4/en/latin:
- invoice01a1c455-29fa-769b-84f9-377a9bcdab46 → tpl/platform/invoice.hbs
- estimate01a1c455-29fa-7963-88e9-d3cf6e2a8240 → tpl/platform/estimate.hbs
- credit_note01a1c455-29fa-7856-b4ed-a3710fd91ec1 → tpl/platform/credit_note.hbs
- receipt01a1c455-29fa-7811-b4b1-95efbd5b9ea5 → tpl/platform/receipt.hbs

These four mappings are in bundled-pins.json, copied from the actual migration, not invented. The registry also retains all known old seed/fixture keys, but their random legacy UUIDs remain unresolvable without an explicit trustworthy mapping supplied by Ironhide. Migration998 deliberately fails on conflicting old platformv1 IDs; frontend does NOT adopt/overwrite IDs or run the migration. Deployment/application of998 is a backend/data-model release dependency, not a frontend action.

## Versioning / receipt

bundled-v1.json, frozen print catalogues, receipt-template-v1.tsx, template-v1.tsx, print.v1.css and rendering dependencies are sealed by shipped-v1.hashes.json plus a hard-coded registry digest in the unit test. Never re-seal modified shipped content. Add a new registry/renderer version and preserve the old version and its dependencies. If shared formatting must change, retain a versioned copy of old dependencies before changing the new renderer.

Receipt is fully rendered/tested via isolated ReceiptPrintProjectionV1, using the existing PaymentReceipt type plus frozen seller/customer/original bill context and backend words. There is NO API route/button wired and NO invented0.9.5 contract. Adapt to the verified final0.9.5 receipt payload after its SHA lands. Existing Sales invoice/CN/estimate flows use bundled resolution now. The Payment reversed CN variant stays non-GST with no lines/tax table.

Bengali/Gujarati remain clean errors; en/ta words only, no client fallback. All existing B4/B5/N1–N5 and0.9.3 tests are retained. Font/native-speaker/physical paper acceptance is separate QA. No seeded/demo records are changed. No install/deploy/merge.
