---
name: scaffold-feature
description: Scaffold a complete new feature end-to-end (Prisma model, migration, schemas, API routes, tests). Use for new CRUD resources or features that span multiple layers.
argument-hint: <feature-name> [description]
---

# Feature Scaffolding

Scaffold a complete feature for: $ARGUMENTS

## Complete ALL steps in order

### 1. Database Layer
- Add model to `prisma/schema.prisma` with:
  - `id String @id @default(cuid())`
  - `userId String` with `@relation(fields: [userId], references: [id], onDelete: Cascade)`
  - `createdAt DateTime @default(now())`
  - `updatedAt DateTime @updatedAt`
  - `@@index([userId])` for user-scoped queries
- Add the relation field to the `User` model in schema.prisma
- Create migration file at `prisma/migrations/NNNN_<name>/migration.sql`
- Run `npm run docker:dev:db:push` to apply
- Mark migration as applied: `DATABASE_URL="postgresql://librariarr:librariarr@localhost:5433/librariarr" npx prisma migrate resolve --applied NNNN_<name>`
- Regenerate client: `npx prisma generate`

### 2. Validation Layer
- Add create schema to `src/lib/validation.ts` using `zod/v4`
- Add update schema (`.partial()`) if the resource supports updates
- Follow naming convention: `featureCreateSchema`, `featureUpdateSchema`

### 3. API Routes
Create following the project's exact patterns:

**`src/app/api/<feature>/route.ts`** (list + create):
- GET: auth check → `findMany({ where: { userId: session.userId! } })` → `sanitize()`
- POST: auth check → `validateRequest()` → create → return `sanitize()` with status 201

**`src/app/api/<feature>/[id]/route.ts`** (read + update + delete):
- PUT: auth check → validate → `findFirst` for ownership → update → `sanitize()`
- DELETE: auth check → `findFirst` for ownership → delete → `{ success: true }`

Key conventions:
- Import prisma from `@/lib/db` (NEVER `@/lib/prisma`)
- Schemas from `@/lib/validation` (NEVER inline)
- Wrap responses with `sanitize()` from `@/lib/api/sanitize`
- Dynamic params: `{ params }: { params: Promise<{ id: string }> }` (Next.js 16)
- Ownership: `findFirst({ where: { id, userId: session.userId! } })` not bare `findUnique`

### 4. Integration Tests
Create at `tests/integration/<category>/<name>.test.ts`:

Required mocks (exact boilerplate):
```typescript
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
```

Import route handlers AFTER mocks. Use `function()` for constructor mocks (not arrows).

Standard test cases: 401 unauthorized, validation errors, CRUD operations, cross-user isolation.

### 5. Test Infrastructure Updates
- Add `deleteMany()` to `tests/setup/test-db.ts` `cleanDatabase()` in correct FK dependency order
- Add data factory `createTest<Feature>()` to `tests/setup/test-helpers.ts` if needed

### 6. Backup Service (if persistent user data)
- Check if `src/lib/backup/backup-service.ts` needs to include the new table in backup/restore

### 7. Documentation
- Update relevant doc in `docs/src/content/docs/docs/` or create new MDX file
- Add sidebar entry in `docs/astro.config.mjs` if new page

### 8. Verification
- `npm run lint` passes
- `npx vitest run tests/integration/<category>/<name>.test.ts` passes
- `npm run build` succeeds (catches type errors)
