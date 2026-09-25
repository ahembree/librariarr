#!/usr/bin/env bash
#
# Local equivalent of the CI job set, for validating a dependency bump before merging it.
#
#   validate.sh --setup     start Postgres and create the librariarr role + DB (once per session)
#   validate.sh             install, prisma generate, lint, typecheck, unit, integration, build
#   validate.sh --quick     skip the integration tests and the build (fast iteration)
#
# This is NOT the whole CI job set: Docker Build and Browser E2E are not run here. E2E is the
# job that catches what the route tests' mocks hide, so it has to be confirmed on the pushed
# branch before merging. `pnpm e2e:docker` runs the same stack locally but needs a Docker
# daemon, which the cloud container does not have.
#
# Integration tests: tests/setup/global-setup.ts runs `prisma db push --accept-data-loss`,
# which Prisma refuses when it detects an AI agent. Rather than bypassing that guard, this
# script builds librariarr_test itself — `migrate deploy` for the migration files, plus the
# `migrate diff` script for the schema-only columns db push would have added (migrations lag
# schema.prisma by design; see "Prisma and Database" in CLAUDE.md) — and then runs vitest with
# VITEST_SKIP_DB_SETUP=true. The diff is refused if it contains a data-losing statement (DROP
# TABLE/COLUMN, TRUNCATE, DELETE FROM) so a schema change that would destroy data stops the run.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT" || exit 1

WORK="${TMPDIR:-/tmp}/merge-dep-prs"
mkdir -p "$WORK"

PGUSER_NAME=librariarr
PGPASS=librariarr
export PGPASSWORD="$PGPASS"
BASE_URL="postgresql://${PGUSER_NAME}:${PGPASS}@localhost:5432"
TEST_URL="${BASE_URL}/librariarr_test"

say() { printf '\n=== %s\n' "$*"; }

# Run a psql/createdb command as the postgres superuser. `su` without a tty either prompts or
# dies confusingly, so require root and say so plainly rather than hanging the run.
as_postgres() {
  if [ "$(id -u)" = 0 ]; then su postgres -c "$1"
  elif command -v sudo >/dev/null 2>&1; then sudo -n -u postgres sh -c "$1"
  else echo "need root (or passwordless sudo) to administer postgres"; return 1
  fi
}

setup_postgres() {
  say "postgres"
  if ! pg_isready -h localhost -q 2>/dev/null; then
    (service postgresql start || pg_ctlcluster "$(pg_lsclusters -h | awk 'NR==1{print $1}')" main start) >/dev/null 2>&1
    for _ in $(seq 1 30); do pg_isready -h localhost -q 2>/dev/null && break; sleep 1; done
  fi
  pg_isready -h localhost || { echo "postgres did not start"; exit 1; }

  as_postgres "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='${PGUSER_NAME}'\"" 2>/dev/null | grep -q 1 \
    || as_postgres "psql -q -c \"CREATE ROLE ${PGUSER_NAME} LOGIN SUPERUSER PASSWORD '${PGPASS}'\"" \
    || { echo "could not create the ${PGUSER_NAME} role"; exit 1; }
  psql -h localhost -U "$PGUSER_NAME" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='librariarr'" | grep -q 1 \
    || createdb -h localhost -U "$PGUSER_NAME" librariarr \
    || { echo "could not create the librariarr database"; exit 1; }
  echo "postgres ready"
}

# Rebuild librariarr_test from scratch: migrations + the additive schema-only diff.
provision_test_db() {
  psql -h localhost -U "$PGUSER_NAME" -d postgres -q \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='librariarr_test' AND pid <> pg_backend_pid()" >/dev/null
  psql -h localhost -U "$PGUSER_NAME" -d postgres -q -c "DROP DATABASE IF EXISTS librariarr_test" >/dev/null 2>&1
  # If the drop above lost a race with a lingering connection, CREATE fails and the suite would
  # otherwise run against the stale database that survived.
  psql -h localhost -U "$PGUSER_NAME" -d postgres -q -c "CREATE DATABASE librariarr_test" >/dev/null \
    || { echo "could not recreate librariarr_test"; return 1; }

  DATABASE_URL="$TEST_URL" pnpm exec prisma migrate deploy >/dev/null 2>&1 \
    || { echo "prisma migrate deploy failed"; return 1; }

  # A failure here must not read as "no drift": that would run the suite against a DB missing
  # the schema-only columns, failing in ways that look like the dependency bump's fault.
  if ! DATABASE_URL="$TEST_URL" pnpm exec prisma migrate diff \
      --from-config-datasource --to-schema prisma/schema.prisma --script > "$WORK/drift.sql" 2>"$WORK/drift.err"; then
    echo "prisma migrate diff failed:"; tail -5 "$WORK/drift.err"; return 1
  fi

  # Match the data-losing forms wherever they appear on the line, not just at its start:
  # Prisma writes a column drop as `ALTER TABLE "x" DROP COLUMN "y"`, which an anchored ^DROP
  # never sees. Matching a bare DROP/DELETE instead would be worse than useless — `ON DELETE
  # CASCADE` appears in every foreign key Prisma emits, and DROP CONSTRAINT / DROP INDEX are
  # routine and lose no rows — so a blunt guard would fire on safe diffs until it got ignored.
  if grep -niE '\b(DROP[[:space:]]+(TABLE|COLUMN|DATABASE|SCHEMA)|TRUNCATE|DELETE[[:space:]]+FROM)\b' "$WORK/drift.sql"; then
    echo "REFUSING: schema drift is destructive (lines above) — inspect $WORK/drift.sql"
    return 1
  fi
  if [ -s "$WORK/drift.sql" ]; then
    psql -h localhost -U "$PGUSER_NAME" -d librariarr_test -q -f "$WORK/drift.sql" >/dev/null \
      || { echo "applying schema drift failed"; return 1; }
  fi
}

if [ "${1:-}" = "--setup" ]; then
  setup_postgres
  exit 0
fi

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

fail=0
note_fail() { fail=1; echo "!!! $1 FAILED"; }

say "install"
pnpm install --frozen-lockfile 2>&1 | tail -3 || { echo "install failed"; exit 1; }
pnpm exec prisma generate 2>&1 | tail -1

say "lint"
pnpm lint 2>&1 | tail -3 || note_fail lint

say "typecheck"
if out=$(pnpm exec tsc --noEmit 2>&1); then echo "tsc clean"; else echo "$out" | head -30; note_fail typecheck; fi

say "unit tests"
pnpm test:unit 2>&1 | tail -6 || note_fail "unit tests"

if [ "$QUICK" = "0" ]; then
  say "integration tests"
  if provision_test_db; then
    VITEST_SKIP_DB_SETUP=true pnpm exec vitest run tests/integration 2>&1 | tail -6 || note_fail "integration tests"
  else
    note_fail "integration test DB provisioning"
  fi

  say "build"
  DATABASE_URL="postgresql://build:build@localhost/build" pnpm build 2>&1 | tail -4 || note_fail build
else
  say "skipped integration tests and build (--quick)"
fi

say "RESULT: $([ "$fail" = "0" ] && echo PASS || echo FAIL)"
exit "$fail"
