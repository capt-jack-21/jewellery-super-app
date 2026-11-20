# Print-language and paper corrections before first deployment

Release PRINT choices are English and Tamil only. UI-language master lists/personal/shop UI overrides are unchanged. Shared immutable historical formatter support for other languages remains for compatibility, but is not a print-language picker.

- SalesSettings.print_language is READ-ONLY in0.9.4; SalesSettingsPatch has no writer. settings.tsx shows the exact unsupported stored code and directs an explicit en/ta print-time override or owner template setting change; it does not invent a PATCH field.
- PrintPanel follows asynchronous shop defaults while untouched. Unsupported stored values leave no language selected and disable print until explicit en/ta choice. Unsupported inherited reprint language errors likewise require a new explicit selection, never silently remap/retry as English. Valid reprints may retain server-pinned language. No template metadata fetch added.
- Print-template draft, generic print preview, language-settings print sample and rate-card overrides all offer only English/Tamil, with no bilingual/hi/te/kn/ml choices. Unsupported stored template rows stay visibly unsupported and cannot be activated; no fromContract English fallback in these controls.
- No seeded/demo data or UI-language settings were rewritten.

Ratchet final report read in full. C1 uses actual bundled immutable templates+998 exact UUIDs (previous follow-up); C2's metadata endpoint is no longer a Sales printing dependency. Ironhide still owns the general inherited-scope metadata endpoint and explicit trusted bindings for any unknown historical/custom UUID. Receipt route still awaits final0.9.5 SHA. C3's six-language requirement is explicitly superseded by the lead's en/ta-only release decision, not claimed implemented. C5 missing-idempotency-header HTTP400 is backend-owned; frontend Idempotency-Key behavior remains covered. Legacy nullable pins/seller guards and NOT VALID historical SQL checks are not repaired/backfilled by frontend.

C4: fixed pre-deployment v1 CSS as expressly authorized: no v1 was deployed. Thermal is an explicit valid80mm×297mm paginated ticket, not invalid80mm auto. A4=210×297mm; A5=148×210mm. Each sales root uses its exact named page. Global A4 was removed; rate-card has its OWN named page. Only print.v1.css changed inside the sealed renderer dependency set; its hash registry/digest was updated for this approved pre-deployment correction. After first deployment, versions must be added rather than changed.

Unit tests parse page-size values and named selectors; VPS npm test also launches existing cached Chromium for CSSOM/page-property and every-page PDF MediaBox checks on long in-memory documents, no app server/API/DB. These diagnostics are not native/GST/physical acceptance PDFs. No font/words/renderer content changed.

Ratchet N2 gets an actual rendered BillScreen stale-selection effect test, not only the eligibility predicate. N1 receives a fresh source/dist manifest at final validation. Remaining backend/live API/physical/native/font-embedding acceptance belongs to QA/authorized environment owners; no claim of release-wide QA PASS from unit counts.
