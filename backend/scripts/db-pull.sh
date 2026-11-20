#!/usr/bin/env bash
# Introspect a freshly migrated DB into packages/db/src/schema/generated/schema.ts (types only).
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/test-db.sh
if [ -z "${INTROSPECT_DATABASE_URL:-}" ]; then   # same host/port/password sources as test-db.sh; never printed
  PW=${TEST_ROLE_PASSWORD:-$(cat "${TEST_ROLE_PASSWORD_FILE:-${XDG_RUNTIME_DIR:-/tmp}/jw-test-role-pw-${USER:-$(id -un)}}")}
  export INTROSPECT_DATABASE_URL="postgres://app_migrator:$PW@${PGHOST:-${TEST_DB_HOST:-127.0.0.1}}:${PGPORT:-${TEST_DB_PORT:-55432}}/${TEST_DB:?TEST_DB is required: set it explicitly to jw_it or a qa_* database (no default)}"
fi
npx drizzle-kit pull --config drizzle.config.ts
G=packages/db/src/schema/generated
rm -rf "$G"/*.sql "$G"/meta "$G"/relations.ts   # never keep drizzle migrations; relations unused
FKS=$(mktemp); trap 'rm -f "$FKS"' EXIT
# FK pairs straight from pg_constraint (URL never printed; psql errors are filtered of URLs)
psql "$INTROSPECT_DATABASE_URL" -At -F $'\t' -v ON_ERROR_STOP=1 -f scripts/fk-pairs.sql > "$FKS" 2> >(sed -E 's#postgres(ql)?://[^ ]*#<url>#g' >&2)
[ -s "$FKS" ] || { echo "db-pull: no FK rows from pg_constraint" >&2; exit 1; }
python3 scripts/fix-drizzle.py "$G/schema.ts" --fks "$FKS"
