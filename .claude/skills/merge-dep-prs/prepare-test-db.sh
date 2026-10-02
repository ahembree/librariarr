#!/usr/bin/env bash
#
# Build a clean librariarr_test, so `VITEST_SKIP_DB_SETUP=true pnpm exec vitest run
# tests/integration` can run. Idempotent; run it before each integration run.
#
# This exists as a script, rather than as commands in SKILL.md, only because it is fiddly and
# repeated once per PR. Everything else in the workflow is a plain pnpm command — run those
# directly so you see their full output.
#
# Why not just let the test harness do it: tests/setup/global-setup.ts runs
# `prisma db push --accept-data-loss`, which Prisma refuses when it detects an AI agent. Do not
# set PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION and do not edit that file. `migrate deploy`
# alone is not equivalent either — migrations lag schema.prisma by design (see "Prisma and
# Database" in CLAUDE.md), so the schema-only columns db push would have added come from
# `migrate diff`, which is checked for data-losing statements before it is applied.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../../.." || exit 1
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

DB=librariarr_test
PGUSER_NAME=librariarr
export PGPASSWORD=librariarr
TEST_URL="postgresql://${PGUSER_NAME}:${PGPASSWORD}@localhost:5432/${DB}"
psql_admin() { psql -h localhost -U "$PGUSER_NAME" -d postgres -q "$@"; }

# `su` off a tty either prompts or dies confusingly, so be explicit about needing root.
as_postgres() {
  if [ "$(id -u)" = 0 ]; then su postgres -c "$1"
  elif command -v sudo >/dev/null 2>&1; then sudo -n -u postgres sh -c "$1"
  else echo "need root (or passwordless sudo) to administer postgres"; return 1
  fi
}

if ! pg_isready -h localhost -q 2>/dev/null; then
  (service postgresql start || pg_ctlcluster "$(pg_lsclusters -h | awk 'NR==1{print $1}')" main start) >/dev/null 2>&1
  for _ in $(seq 1 30); do pg_isready -h localhost -q 2>/dev/null && break; sleep 1; done
  pg_isready -h localhost >/dev/null || { echo "postgres did not start"; exit 1; }
fi

as_postgres "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='${PGUSER_NAME}'\"" 2>/dev/null | grep -q 1 \
  || as_postgres "psql -q -c \"CREATE ROLE ${PGUSER_NAME} LOGIN SUPERUSER PASSWORD '${PGPASSWORD}'\"" \
  || { echo "could not create the ${PGUSER_NAME} role"; exit 1; }

psql_admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB}' AND pid <> pg_backend_pid()" >/dev/null
psql_admin -c "DROP DATABASE IF EXISTS ${DB}" >/dev/null 2>&1
# If the drop lost a race with a lingering connection, the suite would otherwise silently run
# against the stale database that survived.
psql_admin -c "CREATE DATABASE ${DB}" >/dev/null || { echo "could not recreate ${DB}"; exit 1; }

DATABASE_URL="$TEST_URL" pnpm exec prisma migrate deploy >/dev/null 2>&1 \
  || { echo "prisma migrate deploy failed"; exit 1; }

# A failure here must not read as "no drift": that would run the suite against a database
# missing the schema-only columns, failing in ways that look like the dependency bump's fault.
DATABASE_URL="$TEST_URL" pnpm exec prisma migrate diff \
  --from-config-datasource --to-schema prisma/schema.prisma --script > "$WORK/drift.sql" 2>"$WORK/err" \
  || { echo "prisma migrate diff failed:"; tail -5 "$WORK/err"; exit 1; }

# Matched mid-line, since Prisma writes a column drop as `ALTER TABLE "x" DROP COLUMN "y"` and
# an anchored ^DROP never sees it. Matching a bare DROP/DELETE would be worse than useless:
# `ON DELETE CASCADE` is in every foreign key Prisma emits, and DROP CONSTRAINT / DROP INDEX
# lose no rows, so a blunt guard would fire on safe diffs until someone learned to ignore it.
if grep -niE '\b(DROP[[:space:]]+(TABLE|COLUMN|DATABASE|SCHEMA)|TRUNCATE|DELETE[[:space:]]+FROM)\b' "$WORK/drift.sql"; then
  echo "REFUSING: schema drift is destructive (lines above). Inspect it before going further."
  cp "$WORK/drift.sql" ./drift-refused.sql && echo "saved to ./drift-refused.sql"
  exit 1
fi

[ -s "$WORK/drift.sql" ] && { psql -h localhost -U "$PGUSER_NAME" -d "$DB" -q -f "$WORK/drift.sql" >/dev/null \
  || { echo "applying schema drift failed"; exit 1; }; }

echo "${DB} ready"
