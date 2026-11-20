# Demo seed (dev/test only)
Files: `dev_demo_5_shops.sql` (seed), `dev_demo_cleanup.sql` (cleanup), `run_demo_seed.sh` (VPS runner),
`verify_demo.sql` / `verify_demo_app.sql` (read-only checks). Data only, no DDL; all re-runnable; run as role app_migrator.
Shared demo password: created once with `openssl rand`, kept only in a private file on the dev server (mode 600; path passed as DEMO_LOGINS_FILE);
the DB gets an argon2id hash (backend params m=19456,t=2,p=1).

TEST:  `with-lock.sh jewellery-data-model bash seeds/run_demo_seed.sh test-seed|test-cleanup`
DEV (needs dev@ for the hash and deploy@ for docker):
    { ssh dev@VPS 'printf "\\\\set pwhash "; bash /opt/jewellery/src/jewellery-data-model/seeds/run_demo_seed.sh hash; echo;
                   cat /opt/jewellery/src/jewellery-data-model/seeds/dev_demo_5_shops.sql'; } |
      ssh deploy@VPS 'docker exec -i -e PGOPTIONS=-crole=app_migrator jewellery-dev-postgres-1 sh -c "psql -X -q -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\""'
Cleanup on dev: same docker exec with `dev_demo_cleanup.sql` on stdin.

Cleanup limits (immutability, not bypassed): platform.audit_event rows of demo tenants stay (append-only);
app_migrator has no DELETE policy on platform.tenant, so demo tenants are emptied and tombstoned
(`demo-deleted-<id>`, suspended, unlinked from the partner; chain head kept). The demo partner and its login are deleted.
Re-running the seed re-hashes the demo passwords (new salt), which appends one audit event per demo user.

## demo_todays_rates.sql (today's demo rates)
Adds today's (IST) shop-wide `sale` and `old_metal` rates for every active metal and purity of the 5 demo shops, so
`rates.v_todays_rate_status` / `platform.v_billing_unlocked` show the rates as set. It is data only and runs in one transaction.
- **Idempotent:** a purity/kind that already has a shop-wide rate today is skipped, so real entries are never overwritten.
- **Values:** source `demo_seed`; INR per gram = base × fineness / 1000, with GOLD 7,850, SILVER 98, PLATINUM 3,150. Old metal is 97% of sale. Other metal codes are skipped with a NOTICE.
- **Login:** run as dev_seed (app_rw privileges). Tenants are resolved with `platform.resolve_tenant(slug)`, and an unknown slug aborts the run.
- **Run it daily:** rates are dated, so the demo shops lock again the next day until it is run again.
    psql "$DEV_DB_URL" -X -q -v ON_ERROR_STOP=1 -f seeds/demo_todays_rates.sql            # 5 demo slugs
    psql "$DEV_DB_URL" -X -q -v ON_ERROR_STOP=1 -v slugs=demo-cbe-sri-valli -f seeds/demo_todays_rates.sql
Not run on dev by the data-model work. Tested in run_all.sh (DR1–DR3).

## demo_cbe_rs_puram_tags.sql (RS Puram tagged pieces — test / approved-dev only)
Adds **9** `in_stock` tags at branch **CBE** ("RS Puram, Coimbatore") of **demo-cbe-sri-valli** only. Data only, one transaction, idempotent (`DEMO-RSP-01`…`09`; skips existing tag_no). Aborts if the slug or branch is missing.
- **Spread:** 22K gold RING/CHAIN/BANGLE, 18K STUD18, 925 silver ANKLET (uses existing demo items/purities; no new masters).
- **Login:** app_rw / dev_seed. Resolve tenant via `platform.resolve_tenant`.
- **Not run on dev** by the data-model work. Dev needs Adithya's approval through Ultra Magnus.
    psql "$TEST_DB_URL" -X -q -v ON_ERROR_STOP=1 -f seeds/demo_cbe_rs_puram_tags.sql   # after demo shops exist on test

