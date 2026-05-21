---
name: prisma-migration
description: Create a Prisma migration file for schema changes. Required for production — db push only works in dev. Use after modifying schema.prisma.
argument-hint: <migration-name>
---

# Prisma Migration Generator

Create a migration for: $ARGUMENTS

## Why This Matters
- **Production** uses `prisma migrate deploy` which ONLY applies migration files
- **Dev** uses `prisma db push` (no migration files needed for iteration)
- Every schema change MUST have a migration file before merging to main
- Forgetting this means schema changes silently don't apply in production

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
ALTER TABLE "TableName" ADD COLUMN "columnName" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
```

**Add index:**
```sql
CREATE INDEX "TableName_columnName_idx" ON "TableName"("columnName");
```

**Add unique constraint:**
```sql
ALTER TABLE "TableName" ADD CONSTRAINT "TableName_columnName_key" UNIQUE ("columnName");
```

**Create new table:**
```sql
CREATE TABLE "TableName" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
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
   npm run docker:dev:db:push
   ```
5. Mark migration as already applied on dev DB:
   ```bash
   DATABASE_URL="postgresql://librariarr:librariarr@localhost:5433/librariarr" npx prisma migrate resolve --applied NNNN_$ARGUMENTS
   ```
6. Verify migration status:
   ```bash
   DATABASE_URL="postgresql://librariarr:librariarr@localhost:5433/librariarr" npx prisma migrate status
   ```
   Should show "Database schema is up to date!"
7. Regenerate Prisma client: `npx prisma generate`

## Post-Migration Checklist
- If adding a new table: add `deleteMany()` call to `tests/setup/test-db.ts` `cleanDatabase()` in correct dependency order
- If adding a table with user data: consider adding to `src/lib/backup/backup-service.ts`
- If adding a table that needs test data: add a factory function to `tests/setup/test-helpers.ts`
