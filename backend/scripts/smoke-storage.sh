#!/usr/bin/env bash
# smoke-storage.sh — 0.5.1 object-storage smoke test against a DEPLOYED API backed by real Garage.
# For Wheeljack during the deploy window. Not run by CI or by the dev user (no Docker / no live access).
#
# Required env (never hardcode; values are never printed):
#   SMOKE_BASE_URL       site origin, no trailing slash, e.g. https://staging.example.in  (API at /api, links at /files)
#   SMOKE_TENANT         test tenant slug, e.g. smoke-shop
#   SMOKE_LOGIN          test user with platform.import.run (owner/manager), e.g. smoke-owner
#   SMOKE_PASSWORD       that user's password
#   FILE_TOKEN_SECRET    the SAME value the API runs with (used only locally, in-process, to mint an expired token)
# Optional:
#   SMOKE_INSECURE=1     allow a self-signed TLS cert (curl -k)
#
# Expired-token check (step 6): the script takes the real token from step 3, decodes its payload, sets the expiry
# 10 minutes in the past and re-signs it with FILE_TOKEN_SECRET (same scheme as file-token.ts:
# base64url(payload) "." base64url(HMAC-SHA256(secret, "jw.file.v1." + payload))). No test-only TTL or flag exists in
# the API, so production is not weakened. The secret is read from the environment inside python3, never on a command line.
#
# Side effects: one dry-run import job (writes no customers), its platform.file row and the stored CSV in the tenant's bucket prefix.
# There is no delete endpoint for import jobs, so those stay; the session is logged out at exit.
# Exit code: 0 if every step PASSes, 1 otherwise, 2 for missing env / tools.
set -uo pipefail

for v in SMOKE_BASE_URL SMOKE_TENANT SMOKE_LOGIN SMOKE_PASSWORD FILE_TOKEN_SECRET; do
  [ -n "${!v:-}" ] || { echo "missing env: $v" >&2; exit 2; }
done
for t in curl python3 sha256sum; do command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 2; }; done
export SMOKE_TENANT SMOKE_LOGIN SMOKE_PASSWORD FILE_TOKEN_SECRET

BASE=${SMOKE_BASE_URL%/}
TMP=$(mktemp -d)
JAR="$TMP/cookies"
CURL=(curl -sS --max-time 30 -b "$JAR" -c "$JAR")
[ "${SMOKE_INSECURE:-}" = 1 ] && CURL+=(-k)
FAILS=0

cleanup() {
  [ -s "$JAR" ] && "${CURL[@]}" -o /dev/null -X POST "$BASE/api/v1/auth/logout" || true
  rm -rf "$TMP"
}
trap cleanup EXIT

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1${2:+ — $2}"; FAILS=$((FAILS + 1)); }
# json FIELD < file  → prints the field (empty if absent)
json() { python3 -c 'import json,sys
try: print(json.load(sys.stdin).get(sys.argv[1]) or "")
except Exception: print("")' "$1"; }
finish() { echo; if [ "$FAILS" -eq 0 ]; then echo "RESULT: PASS"; exit 0; else echo "RESULT: FAIL ($FAILS step(s))"; exit 1; fi; }

# 1. login (body built in python from env: the password never appears in argv or output)
code=$(python3 -c 'import json,os; print(json.dumps({"tenant":os.environ["SMOKE_TENANT"],"login":os.environ["SMOKE_LOGIN"],"password":os.environ["SMOKE_PASSWORD"]}))' \
  | "${CURL[@]}" -o "$TMP/login.json" -w '%{http_code}' -H 'content-type: application/json' --data-binary @- "$BASE/api/v1/auth/login")
if [[ "$code" =~ ^20[01]$ ]] && grep -q 'sid' "$JAR"; then pass "1 login (HTTP $code)"; else fail "1 login" "HTTP $code"; finish; fi

# 2. upload a small CSV (dry run only)
CSV="$TMP/smoke.csv"
printf 'name,phone\nSmoke Test %s,98%08d\n' "$(date +%s)" "$((RANDOM * RANDOM % 100000000))" > "$CSV"
WANT=$(sha256sum "$CSV" | cut -d' ' -f1)
code=$("${CURL[@]}" -o "$TMP/up.json" -w '%{http_code}' -F kind=customers -F "file=@$CSV;filename=smoke.csv;type=text/csv" "$BASE/api/v1/imports")
JOB=$(json id < "$TMP/up.json")
FILE=$(json file_id < "$TMP/up.json")   # 0.5.1: the platform.file id; /v1/files/{id}/url takes it
if [ "$code" = 201 ] && [ -n "$JOB" ] && [ -n "$FILE" ]; then pass "2 upload (job $JOB, file $FILE, status $(json status < "$TMP/up.json"))"
else fail "2 upload" "HTTP $code${JOB:+, file_id missing (API older than 0.5.1?)}"; finish; fi

# 3. signed link
code=$("${CURL[@]}" -o "$TMP/url.json" -w '%{http_code}' "$BASE/api/v1/files/$FILE/url")
LINK=$(json url < "$TMP/url.json")
if [ "$code" = 200 ] && [[ "$LINK" =~ ^/files/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]]; then pass "3 GET /v1/files/{id}/url (expires $(json expires_at < "$TMP/url.json"))"
else fail "3 GET /v1/files/{id}/url" "HTTP $code"; finish; fi
TOKEN=${LINK#/files/}

# 4. download with NO cookie; compare sha256 and headers
code=$(curl -sS --max-time 30 ${SMOKE_INSECURE:+-k} -D "$TMP/dl.h" -o "$TMP/dl.bin" -w '%{http_code}' "$BASE$LINK")
GOT=$(sha256sum "$TMP/dl.bin" | cut -d' ' -f1)
if [ "$code" = 200 ] && [ "$GOT" = "$WANT" ] && grep -qi '^cache-control: *no-store' "$TMP/dl.h" && grep -qi '^content-disposition: *attachment' "$TMP/dl.h"; then
  pass "4 download /files/<token> (sha256 match, no-store, attachment)"
else fail "4 download /files/<token>" "HTTP $code, sha256 $([ "$GOT" = "$WANT" ] && echo match || echo MISMATCH)"; fi

# 5. tampered signature → 404
SIG=${TOKEN#*.}; BODY=${TOKEN%%.*}
case "$SIG" in *A) BAD="${SIG%?}B" ;; *) BAD="${SIG%?}A" ;; esac
code=$(curl -sS --max-time 30 ${SMOKE_INSECURE:+-k} -o /dev/null -w '%{http_code}' "$BASE/files/$BODY.$BAD")
[ "$code" = 404 ] && pass "5 tampered token → 404" || fail "5 tampered token" "HTTP $code (want 404)"

# 6. expired token (re-signed locally with FILE_TOKEN_SECRET, expiry 10 min ago) → 410
OLD=$(SMOKE_TOKEN="$TOKEN" python3 - <<'PY'
import base64, hashlib, hmac, json, os, time
body = os.environ["SMOKE_TOKEN"].split(".")[0]
p = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
p["e"] = int(time.time()) - 600
b = base64.urlsafe_b64encode(json.dumps(p, separators=(",", ":")).encode()).rstrip(b"=").decode()
sig = hmac.new(os.environ["FILE_TOKEN_SECRET"].encode(), ("jw.file.v1." + b).encode(), hashlib.sha256).digest()
print(b + "." + base64.urlsafe_b64encode(sig).rstrip(b"=").decode())
PY
)
code=$(curl -sS --max-time 30 ${SMOKE_INSECURE:+-k} -o "$TMP/exp.json" -w '%{http_code}' "$BASE/files/$OLD")
if [ "$code" = 410 ]; then pass "6 expired token → 410"
elif [ "$code" = 404 ]; then fail "6 expired token" "HTTP 404: FILE_TOKEN_SECRET here differs from the API's"
else fail "6 expired token" "HTTP $code (want 410)"; fi

finish
