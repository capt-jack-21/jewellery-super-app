# Jewellery SaaS web — F0 foundation (local only)

Placeholder brand "Jewellery SaaS" comes from branding data (mocks/.env), never from code.

```
npm install
npm run dev          # http://localhost:5173 (MSW mocks on; VITE_API_MOCKS=true)
npm run lint         # eslint (colour literals, raw fetch/parseFloat, JSX text) + check-tokens + check-i18n
npm test             # vitest: formatters, amount-in-words en/ta, dates/FY, tokens/contrast, theme loading, offline queue, mock API
npm run build        # tsc + vite build + service worker (dist/sw.js)
npm run api:generate # Orval: contracts/openapi.draft.yaml → src/lib/api/generated (hooks + zod)
node scripts/smoke.mjs  # headless Chrome: logs in as owner/partner/admin (mocks), screenshots → screenshots/{f0,platform}, checks offline billing gate
```

Routes: `/` rates + formatting, `/counter` offline-pending demo, `/setup` wizard stub, `/dev/tokens` sample brands + WCAG, `/dev/print` bilingual estimate preview.

Rules: no colours outside `src/design-tokens`; offline bills are `pending` and never numbered on the client; money/weight are decimal strings.
Known: PWA service worker is not registered while MSW mocks run (both want scope `/`); test PWA with `VITE_API_MOCKS=false npm run build && npm run preview` once a real API exists. Tamil amount-in-words needs native-speaker/CA review (sandhi forms simplified).
