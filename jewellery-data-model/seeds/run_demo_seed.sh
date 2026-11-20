#!/usr/bin/env bash
# seeds/run_demo_seed.sh — DEV/TEST demo data runner (VPS only). Never prints the demo password or env values.
#   run_demo_seed.sh test-seed      seed the TEST DB (~/.env.test), as role app_migrator
#   run_demo_seed.sh test-cleanup   cleanup on the TEST DB, as role app_migrator
#   run_demo_seed.sh hash           print ONLY the argon2id hash of the shared demo password (for piping into psql on dev)
# The shared password is created once with `openssl rand` and kept in $LOGINS (mode 600); re-runs reuse it.
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "$0")" && pwd)"
LOGINS="${DEMO_LOGINS_FILE:?set DEMO_LOGINS_FILE (path to the private demo login file; never commit it)}"
BACKEND="${BACKEND_DIR:-/opt/jewellery/src/backend}"

ensure_logins() {
  if [ ! -s "$LOGINS" ]; then
    local pw; pw="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20)"
    [ "${#pw}" -ge 16 ] || { echo "password generation failed" >&2; exit 1; }
    {
      echo "# DEMO logins (dev/test only) — generated $(TZ=Asia/Kolkata date '+%F %H:%M IST'). Shared password for every login below."
      echo "password: $pw"
      echo
      echo "# shop (tenant slug) : usernames"
      for s in cbe:demo-cbe-sri-valli:manager,salesperson,cashier chn:demo-chn-kanchi-thangam:manager,salesperson,cashier \
               mdu:demo-mdu-meenakshi-gold:salesperson,cashier tpr:demo-tpr-kongu-jewel:manager,salesperson,cashier \
               slm:demo-slm-shevaroy:manager,salesperson; do
        IFS=: read -r k slug roles <<<"$s"
        printf '%s : demo.%s.owner' "$slug" "$k"
        for r in ${roles//,/ }; do printf ', demo.%s.%s' "$k" "$r"; done; echo
      done
      echo
      echo "# partner (reseller) demo-partner-kovai, linked to demo-cbe-sri-valli and demo-tpr-kongu-jewel"
      echo "partner login (email): partner.admin@demo.invalid"
    } > "$LOGINS"
  fi
  chmod 600 "$LOGINS"
}

make_hash() {   # password passed via env to node, never argv
  DEMO_PW="$(sed -n 's/^password: //p' "$LOGINS")" NODE_PATH="$BACKEND/node_modules/.pnpm/@node-rs+argon2@2.2.2/node_modules" \
  node -e 'const a=require("@node-rs/argon2");a.hash(process.env.DEMO_PW,{algorithm:2,memoryCost:19456,timeCost:2})
    .then(h=>{if(!a.verifySync(h,process.env.DEMO_PW))process.exit(2);process.stdout.write(h)})'
}

test_psql() {   # TEST DB via ~/.env.test, effective role app_migrator (RLS applies)
  set -a; . "$HOME/.env.test"; set +a
  PGHOST="$TEST_DB_HOST" PGPORT="$TEST_DB_PORT" PGUSER="$TEST_DB_USER" PGPASSWORD="$TEST_DB_PASSWORD" \
  PGOPTIONS="-c role=app_migrator" psql -X -q -v ON_ERROR_STOP=1 -d "${TEST_DB_NAME:-jewellery_test}" "$@"
}

case "${1:-}" in
  test-seed)    ensure_logins; DEMO_PWHASH="$(make_hash)"; export DEMO_PWHASH
                { printf '\\getenv pwhash DEMO_PWHASH\n'; cat "$HERE/dev_demo_5_shops.sql"; } | test_psql -f - ;;
  test-cleanup) test_psql -f "$HERE/dev_demo_cleanup.sql" ;;
  hash)         ensure_logins; make_hash ;;
  *) echo "usage: $0 test-seed|test-cleanup|hash" >&2; exit 64 ;;
esac
