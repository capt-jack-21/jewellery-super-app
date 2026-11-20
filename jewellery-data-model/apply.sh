#!/usr/bin/env bash
# Usage: ./apply.sh <dbname>   (local dev: needs sudo -u postgres; passwords are dev-only)
#   APPLY_SET=all      (default) drop + create the DB, bootstrap, apply every migration
#   APPLY_SET=applied  drop + create, bootstrap, apply only the files listed in migrations/APPLIED.sha256 (dev state)
#   APPLY_SET=new      keep the DB, apply only the files NOT listed in APPLIED.sha256 (the upgrade step)
set -euo pipefail
DB=${1:-jewellery}
SET=${APPLY_SET:-all}
cd "$(dirname "$0")"
migration_files() {  # numeric-prefix order (010..999, then 01000...); text-order globs would put 01000 before 010
  ls migrations/*.sql | grep -v '/000_bootstrap\.sql$' | awk -F/ '{n=$NF; sub(/_.*/,"",n); printf "%d\t%s\n", n+0, $0}' | sort -t"$(printf '\t')" -k1,1n -k2,2 | cut -f2
}
if [ "$SET" != new ]; then
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d "$DB" -f migrations/000_bootstrap.sql
# Role passwords are CLUSTER-WIDE. On the shared VPS test cluster they are owned by the backend harness file
# (TEST_ROLE_PASSWORD_FILE); never rotate them there. Only a private local cluster may opt in with DM_ROTATE_ROLE_PASSWORDS=1.
if [ "${DM_ROTATE_ROLE_PASSWORDS:-0}" = 1 ]; then
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d "$DB" -c "ALTER ROLE app_migrator PASSWORD 'dev'" \
  -c "ALTER ROLE app_rw PASSWORD 'dev'" -c "ALTER ROLE app_ro PASSWORD 'dev'" -c "ALTER ROLE app_worker PASSWORD 'dev'" -c "ALTER ROLE app_admin PASSWORD 'dev'"
fi
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d "$DB" -c "GRANT CREATE, TEMP ON DATABASE $DB TO app_migrator"
fi
for f in $(migration_files); do
  listed=no; grep -q " $(basename "$f")\$" migrations/APPLIED.sha256 && listed=yes
  [ "$SET" = applied ] && [ $listed = no ] && continue
  [ "$SET" = new ] && [ $listed = yes ] && continue
  echo "applying $f"
  PGPASSWORD=dev psql -h localhost -U app_migrator -d "$DB" -v ON_ERROR_STOP=1 -q -f "$f"
done
echo "ALL MIGRATIONS APPLIED ($SET)"
