#!/usr/bin/env bash
# =============================================================================
# SQL test suite for the Supabase schema, RLS, RPCs and storage policies.
# Runs against a plain local Postgres cluster (no Docker, no Supabase project):
#
#   1. drop + create the throwaway database `bingo_test`
#   2. apply supabase/tests/local_shim.sql (emulates Supabase roles, auth.*,
#      storage.* and the realtime publication)
#   3. apply every supabase/migrations/*.sql in filename order, each in one
#      transaction with ON_ERROR_STOP (like `supabase db push`)
#   4. apply supabase/tests/test_helpers.sql (test-only `tests` schema)
#   5. run every supabase/tests/*.test.sql and *.test.sh in filename order
#
# Prints one PASS/FAIL line per named test and exits non-zero on any failure
# or if a required test id (a)-(n) did not report PASS.
#
# Connection: BINGO_DB_HOST (127.0.0.1), BINGO_DB_PORT (54329), BINGO_DB_USER
# (postgres, needs superuser + trust/PGPASSWORD). The database name is always
# bingo_test; this script never touches any other database.
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_HOST="${BINGO_DB_HOST:-127.0.0.1}"
DB_PORT="${BINGO_DB_PORT:-54329}"
DB_USER="${BINGO_DB_USER:-postgres}"
DB_NAME="bingo_test"
ADMIN_URL="postgresql://${DB_USER}@${DB_HOST}:${DB_PORT}/postgres"
TEST_URL="postgresql://${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
REQUIRED_IDS=(a b c d e f g h i j k l m n)

die() {
  echo "db-test: $*" >&2
  exit 2
}

setup_psql() {
  PGOPTIONS="-c client_min_messages=error" psql -X -q -v ON_ERROR_STOP=1 "$@"
}

command -v psql >/dev/null 2>&1 || die "psql not found on PATH"
setup_psql "$ADMIN_URL" -c "select 1" >/dev/null 2>&1 ||
  die "cannot connect to $ADMIN_URL (is the local Postgres cluster running?)"

echo "==> Recreating database ${DB_NAME}"
setup_psql "$ADMIN_URL" \
  -c "drop database if exists ${DB_NAME} with (force)" \
  -c "create database ${DB_NAME}" || die "could not recreate ${DB_NAME}"

echo "==> Applying local shim"
setup_psql "$TEST_URL" -f "$ROOT/supabase/tests/local_shim.sql" || die "shim failed"

shopt -s nullglob
migrations=("$ROOT"/supabase/migrations/*.sql)
[ ${#migrations[@]} -gt 0 ] || die "no migrations found"
mapfile -t migrations < <(printf '%s\n' "${migrations[@]}" | LC_ALL=C sort)
for migration in "${migrations[@]}"; do
  echo "==> Applying migration $(basename "$migration")"
  setup_psql -1 "$TEST_URL" -f "$migration" || die "migration failed: $(basename "$migration")"
done

echo "==> Applying test helpers"
setup_psql "$TEST_URL" -f "$ROOT/supabase/tests/test_helpers.sql" || die "test helpers failed"

test_files=("$ROOT"/supabase/tests/*.test.sql "$ROOT"/supabase/tests/*.test.sh)
mapfile -t test_files < <(printf '%s\n' "${test_files[@]}" | LC_ALL=C sort)

pass=0
fail=0
declare -A passed_ids=()

echo "==> Running tests"
for test_file in "${test_files[@]}"; do
  name="$(basename "$test_file")"
  if [[ "$test_file" == *.sql ]]; then
    output="$(PGOPTIONS="-c client_min_messages=warning" \
      psql -X -q -At -v ON_ERROR_STOP=1 "$TEST_URL" -f "$test_file" 2>&1)"
  else
    output="$(bash "$test_file" "$TEST_URL" 2>&1)"
  fi
  status=$?

  while IFS= read -r line; do
    case "$line" in
      PASS\ *)
        echo "$line"
        pass=$((pass + 1))
        id="${line#PASS (}"
        passed_ids["${id%%)*}"]=1
        ;;
      FAIL\ *)
        echo "$line"
        fail=$((fail + 1))
        ;;
      "") ;;
      *) echo "    [$name] $line" ;;
    esac
  done <<<"$output"

  if [ "$status" -ne 0 ]; then
    echo "FAIL [$name] exited with status $status"
    fail=$((fail + 1))
  fi
done

for id in "${REQUIRED_IDS[@]}"; do
  if [ -z "${passed_ids[$id]:-}" ]; then
    echo "FAIL ($id) required test did not report PASS"
    fail=$((fail + 1))
  fi
done

echo "==> ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
