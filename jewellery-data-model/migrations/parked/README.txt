975_platform_referenced_object_keys.sql — PARKED 2026-10-27 per Adithya (file cleanup skipped). NOT to be applied.
sha256: b6e2ffe6118f355c181d5063df97ad4f008f3b96baa73e3adf9453653d7f28a7
Never applied on dev or recorded in APPLIED.sha256. Its tests (RK1–RK12) were removed from tests/; to revive it, restore
it as a new number after the latest applied migration and re-add the tests.
Safe here: apply.sh globs migrations/[0-9]*.sql, run_all.sh lists migrations/[0-9]*.sql, and backend migrate.ts uses a
non-recursive readdirSync(dir) filtered to *.sql. None of them reads subdirectories.
