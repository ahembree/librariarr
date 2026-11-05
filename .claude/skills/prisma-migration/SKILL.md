---
name: prisma-migration
description: Create a Prisma migration file for schema changes. Required for production — db push only works in dev. Use after modifying schema.prisma.
argument-hint: <migration-name>
---

# Prisma Migration Generator

Create a migration for: $ARGUMENTS

## Why This Matters
- **Production** (`docker-entrypoint.sh`) runs `prisma migrate deploy` (applies migration files), then always `prisma db push` without `--accept-data-loss`
- **Dev** uses `prisma db push --accept-data-loss` (`docker-entrypoint.dev.sh`; no migration files needed for iteration)
- Every schema change MUST have a migration file before merging to main
- Forgetting this means production relies on the entrypoint's `db push`, which only adds what is missing: a change it flags as data loss (dropping or retyping a populated column, a rename) fails startup, and data backfills and the expression/partial indexes only migration SQL creates (`0030_query_indexes`) never run

## Migration File Structure

### Naming convention (sequential numbering):
```
prisma/migrations/NNNN_description/migration.sql
```
Check `prisma/migrations/` for the latest number and increment by 1.

### Common SQL Patterns

**Add column:**
```sql
ALTER TABLE "TableName" ADD COLUMN "columnName" TEXT;
```

**Add column with default:**
```sql
ALTER TABLE "TableName" ADD COLUMN "columnName" BOOLEAN NOT NULL DEFAULT false;
```

**Add array column (PostgreSQL):**
```sql
ALTER TABLE "TableName" ADD COLUMN "columnName" TEXT[] DEFAULT ARRAY[]::TEXT[];
```

**Add index:**
```sql
CREATE INDEX "TableName_columnName_idx" ON "TableName"("columnName");
```

**Add unique constraint** (Prisma's `@unique` is a unique index — every migration writes it this way):
```sql
CREATE UNIQUE INDEX "TableName_columnName_key" ON "TableName"("columnName");
```

**Create new table:**

The project's models use `id String @id @default(cuid())` — cuids are generated
app-side by Prisma, so the `id` column has NO database-level default (do NOT use
`gen_random_uuid()` as one; it appears only in `0010_add_collections`' data-backfill
`INSERT … SELECT`). This matches every cuid table in `0001_init` (the one id default
there is `SystemConfig`'s literal `'singleton'`).

```sql
CREATE TABLE "TableName" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TableName_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TableName_userId_idx" ON "TableName"("userId");
ALTER TABLE "TableName" ADD CONSTRAINT "TableName_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

**Create enum:**
```sql
CREATE TYPE "EnumName" AS ENUM ('VALUE1', 'VALUE2');
```

**Add enum value:**
```sql
ALTER TYPE "EnumName" ADD VALUE 'NEW_VALUE';
```

**Drop column:**
```sql
ALTER TABLE "TableName" DROP COLUMN "columnName";
```

## Steps

1. Check `prisma/migrations/` to determine the next migration number
2. Update `prisma/schema.prisma` with the schema changes
3. Create `prisma/migrations/NNNN_$ARGUMENTS/migration.sql` with the SQL
4. Push schema to dev DB:
   ```bash
   pnpm docker:dev:db:push
   ```
5. Check the migration against a scratch database. The dev DB is built by `db push` and has no migration history, so `prisma migrate resolve` / `migrate status` against it prove nothing:
   ```bash
   export PGPASSWORD=librariarr
   psql -h localhost -U librariarr -d postgres -c "DROP DATABASE IF EXISTS librariarr_migcheck" -c "CREATE DATABASE librariarr_migcheck"
   export DATABASE_URL=postgresql://librariarr:librariarr@localhost:5432/librariarr_migcheck
   pnpm exec prisma migrate deploy   # what CI's "Validate migrations" step runs
   pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
   ```
   The diff must not list anything your migration was meant to create.
6. Drop the scratch database (`psql -h localhost -U librariarr -d postgres -c "DROP DATABASE librariarr_migcheck"`)
7. Regenerate Prisma client: `pnpm exec prisma generate`

## Post-Migration Checklist
- If adding a new table: nothing to add to `tests/setup/test-db.ts` — `cleanDatabase()` truncates every `public` table it reads from `pg_tables`
- If adding a new model: place it in `BACKUP_TABLE_ORDER` or `BACKUP_EXCLUDED_TABLES` in `src/lib/backup/backup-service.ts` (enforced by `tests/unit/backup/table-order.test.ts`; see the `backup-restore` skill)
- If adding a table that needs test data: add a factory function to `tests/setup/test-helpers.ts`
