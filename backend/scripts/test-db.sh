#!/usr/bin/env bash
# Test harness DB: superuser bootstrap (000_bootstrap.sql) → `node apps/api/dist/migrate.js` as app_migrator → seed.
# Everything comes from env; nothing secret lives in the repo:
#   superuser  PG_SUPERUSER_URL, else TEST_ADMIN_DATABASE_URL, else `sudo -u postgres` (local dev)
#   host/port  PGHOST/PGPORT, else TEST_DB_HOST/TEST_DB_PORT, else 127.0.0.1:55432 (postgres-test)
#   role pw    TEST_ROLE_PASSWORD, else a random one generated per DB build and kept (0600) in
#              ${TEST_ROLE_PASSWORD_FILE:-${XDG_RUNTIME_DIR:-/tmp}/jw-test-role-pw-$USER} — tests/integration/env.ts reads the same.
set -euo pipefail
cd "$(dirname "$0")/.."
DM=${DATA_MODEL_DIR:-/workspace/jewellery-data-model}
DB=${TEST_DB:?TEST_DB is required: set it explicitly to jw_it or a qa_* database (no default)}
HOST=${PGHOST:-${TEST_DB_HOST:-127.0.0.1}}
PORT=${PGPORT:-${TEST_DB_PORT:-55432}}
SU_URL=${PG_SUPERUSER_URL:-${TEST_ADMIN_DATABASE_URL:-}}
PW_FILE=${TEST_ROLE_PASSWORD_FILE:-${XDG_RUNTIME_DIR:-/tmp}/jw-test-role-pw-${USER:-$(id -un)}}
if [ -n "${TEST_ROLE_PASSWORD:-}" ]; then PW=$TEST_ROLE_PASSWORD
else (umask 077; od -An -N16 -tx1 /dev/urandom | tr -d ' \n' > "$PW_FILE"); PW=$(cat "$PW_FILE"); fi
[[ $PW =~ ^[A-Za-z0-9._~-]+$ ]] || { echo "TEST_ROLE_PASSWORD must be URL-safe ([A-Za-z0-9._~-])" >&2; exit 2; }
# su <db> <psql args...>: with a superuser URL the db is swapped into the URL path (psql -d would replace the whole URL)
su() { local db=$1; shift
  if [ -n "$SU_URL" ]; then local base=${SU_URL%%\?*}; psql "${base%/*}/$db" -v ON_ERROR_STOP=1 -q "$@"
  else sudo -u postgres psql -h "$HOST" -p "$PORT" -d "$db" -v ON_ERROR_STOP=1 -q "$@"; fi; }
su postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB'" >/dev/null
su postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
su "$DB" -f "$DM/migrations/000_bootstrap.sql"
# password via psql variable (:'pw' quotes it); never echoed
pwsql=""; for r in app_migrator app_rw app_ro app_worker app_admin; do pwsql+="ALTER ROLE $r PASSWORD :'pw'; "; done
printf '%s\nGRANT CREATE, TEMP ON DATABASE %s TO app_migrator;\n' "$pwsql" "$DB" | su "$DB" -v pw="$PW" -f -
MIGRATIONS_DIR="$DM/migrations" MIGRATOR_DATABASE_URL="postgres://app_migrator:$PW@$HOST:$PORT/$DB" node apps/api/dist/migrate.js
PGPASSWORD=$PW psql -h "$HOST" -p "$PORT" -U app_migrator -d "$DB" -q -v ON_ERROR_STOP=1 -f "$DM/tests/seed.sql" >/dev/null
echo "test DB $DB ready on $HOST:$PORT"
