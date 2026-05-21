---
name: conventions
description: Quick reference for all Librariarr project conventions and patterns. Consult when writing or reviewing code to verify correct patterns.
---

# Librariarr Conventions Quick Reference

## Import Rules

| Module | Correct Import | WRONG |
|--------|---------------|-------|
| Prisma client | `import { prisma } from "@/lib/db"` | `@/lib/prisma` |
| Validation | `import { validateRequest, schema } from "@/lib/validation"` | Inline schemas |
| Zod | `import { z } from "zod/v4"` | `from "zod"` |
| Sanitize | `import { sanitize, sanitizeErrorDetail } from "@/lib/api/sanitize"` | — |
| Session | `import { getSession } from "@/lib/auth/session"` | — |
| Prisma types | `import type { X } from "@/generated/prisma/client"` | — |

## API Route Checklist

Every route handler must:
1. Check auth: `getSession()` + `session.isLoggedIn`
2. Validate mutations: `validateRequest(request, schema)` — schema from `@/lib/validation`
3. Verify ownership: include `userId: session.userId!` in all queries
4. Sanitize responses: wrap with `sanitize()` from `@/lib/api/sanitize`
5. Use `sanitizeErrorDetail()` for error messages from external services
6. Never send stored API keys to frontend — use `[id]/test-connection` endpoints

## Security Rules

- All responses with server/integration data: `sanitize()` (strips accessToken, apiKey, plexToken, passwordHash)
- Media item queries: `library: { mediaServer: { userId: session.userId } }` ownership check
- Auth endpoints: `authRateLimiter` — 10 attempts / 15 min, return 429 with `Retry-After`
- Use `findFirst` with userId filter, NOT bare `findUnique({ where: { id } })`

## Data Patterns

- `fileSize`: stored as `BigInt`, serialize to string in API responses
- `LibraryType`: `"MOVIE" | "SERIES" | "MUSIC"`
- Dynamic params (Next.js 16): `{ params }: { params: Promise<{ id: string }> }` — params is a Promise, must `await`
- Pagination: N+1 trick (`take: limit + 1`, pop last if over), response: `{ items, pagination: { page, limit, hasMore } }`
- Multi-select filters: pipe-separated (`?resolution=4K|1080P`)

## Testing Rules

- Constructor mocks: use `function()` keyword, NOT arrow functions (Vitest 4 requirement)
- `vi.hoisted()`: required when mock variables are referenced inside `vi.mock()` factory functions
- Route imports: MUST come AFTER all `vi.mock()` calls
- Standard mocks: `@/lib/db` → test DB, `@/lib/logger` → all 3 loggers suppressed (logger, apiLogger, dbLogger)
- Session: `setMockSession({ userId, plexToken: "tok", isLoggedIn: true })`
- Cleanup: `cleanDatabase()` + `clearMockSession()` in `beforeEach`, `disconnectTestDb()` in `afterAll`
- Helpers: `callRoute()`, `callRouteWithParams()`, `expectJson<T>(response, status)`

## Styling

- Tailwind CSS v4 with OKLCH color model (not HSL)
- Dark mode: hardcoded via `className="dark"` on `<html>`
- shadcn/ui: "new-york" style variant
- Theme accent colors: override CSS vars `--primary`, `--ring`, `--sidebar-primary`

## Git Conventions

- Conventional commits: `type(scope): description`
- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `style`, `perf`
- Pre-commit hook: `npx next lint --quiet`
- Commit-msg hook: commitlint (`@commitlint/config-conventional`)

## Database Conventions

- Schema changes need migration files for production (`prisma migrate deploy` only reads migration files)
- Dev iteration: `npm run docker:dev:db:push` (no migration files needed)
- Migration naming: sequential `0001_init`, `0002_description`, etc.
- After schema changes: `npx prisma generate` to regenerate client

## Key File Locations

| Purpose | Path |
|---------|------|
| Prisma singleton | `src/lib/db.ts` |
| All Zod schemas | `src/lib/validation.ts` |
| Response sanitization | `src/lib/api/sanitize.ts` |
| Session/auth | `src/lib/auth/session.ts` |
| Multi-server dedup | `src/lib/dedup/server-filter.ts` |
| Filter utilities | `src/lib/filters/build-where.ts` |
| Memory cache | `src/lib/cache/memory-cache.ts` |
| Rate limiter | `src/lib/rate-limit/rate-limiter.ts` |
| Test DB setup | `tests/setup/test-db.ts` |
| Test helpers/factories | `tests/setup/test-helpers.ts` |
| Session mocking | `tests/setup/mock-session.ts` |
