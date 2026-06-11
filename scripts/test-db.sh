#!/usr/bin/env bash
# Run the pgTAP suite in supabase/tests/database/ against a scratch database.
#
# Needs a Postgres 16+ server with the postgis and pgtap extensions available
# (Ubuntu: postgresql-16 postgresql-16-postgis-3 postgresql-16-pgtap). The
# Supabase platform schemas are stubbed by supabase/tests/shim/ so no Supabase
# image or CLI is required. Alternatively, `npx supabase test db` runs the
# same test files against the CLI's local stack.
#
# Config: PGTEST_ADMIN_URL — superuser connection string to the server
#         (default: postgresql:///postgres via local socket, peer auth).
set -euo pipefail
cd "$(dirname "$0")/.."

ADMIN_URL="${PGTEST_ADMIN_URL:-postgresql:///postgres}"
TEST_DB="midsouthwx_test"
TEST_URL="${ADMIN_URL%/*}/${TEST_DB}"

psql -X -q "$ADMIN_URL" -v ON_ERROR_STOP=1 \
  -c "drop database if exists ${TEST_DB}" \
  -c "create database ${TEST_DB}"

psql -X -q "$TEST_URL" -v ON_ERROR_STOP=1 \
  -c "create extension if not exists postgis" \
  -c "create extension if not exists pgcrypto" \
  -c "create extension if not exists pgtap" \
  -f supabase/tests/shim/supabase-shim.sql

# Apply every migration in order. pg_cron / pg_net aren't installable on a
# vanilla server — their schemas are stubbed by the shim, so strip those two
# `create extension` statements. Autocommit per statement (no -1): some
# migrations use `alter type ... add value`, which refuses to run inside a
# transaction block.
fails=0
for f in supabase/migrations/*.sql; do
  if ! sed -e 's/^create extension if not exists pg_cron;//' \
           -e 's/^create extension if not exists pg_net;//' "$f" \
       | psql -X -q "$TEST_URL" -v ON_ERROR_STOP=1 >/dev/null; then
    echo "MIGRATION FAILED: $f" >&2
    exit 1
  fi
done

echo "migrations applied: $(ls supabase/migrations/*.sql | wc -l)"

# Run each test file and evaluate its TAP output (-tA: tuples-only, unaligned,
# so TAP lines come out clean for the pass/fail grep).
status=0
for t in supabase/tests/database/*.sql; do
  echo "=== $t"
  out="$(psql -X -q -tA "$TEST_URL" -v ON_ERROR_STOP=1 -f "$t" 2>&1)" || status=1
  echo "$out"
  if echo "$out" | grep -qE "^not ok|^ERROR|Looks like you"; then
    status=1
  fi
done

if [ "$status" -ne 0 ]; then
  echo "TESTS FAILED" >&2
else
  echo "ALL TESTS PASSED"
fi
exit "$status"
