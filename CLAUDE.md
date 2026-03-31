# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Librariarr is a media library management webapp for Plex, Jellyfin, and Emby servers. It uses Plex OAuth for authentication, syncs media metadata from connected servers, provides filterable library browsing, and includes a lifecycle rule engine for automated media management.

## Commands

### Development (Docker-based, preferred)

```bash
pnpm docker:dev          # Start dev environment (foreground)
pnpm docker:dev:detach   # Start dev environment (background)
pnpm docker:dev:down     # Stop dev environment
pnpm docker:dev:rebuild  # Rebuild containers from scratch
pnpm docker:dev:clean    # Stop containers and delete DB volume
pnpm docker:dev:logs     # Tail dev container logs
```

### Database Commands

```bash
pnpm docker:dev:db:push    # Push schema changes (no migration files)
pnpm docker:dev:db:migrate # Run Prisma migrations
pnpm docker:dev:db:studio  # Open Prisma Studio (DB browser)
pnpm docker:dev:db:reset   # Reset DB completely
```

### Build and Lint

```bash
pnpm build   # Next.js production build
pnpm lint    # ESLint
pnpm exec prisma generate  # Regenerate Prisma client (needed after schema changes when DB isn't available)
```

### Testing

Requires the Docker DB to be running (`pnpm docker:dev` or `pnpm docker:dev:detach`).

```bash
pnpm test                    # Run full test suite
pnpm test:watch              # Watch mode
pnpm test:unit               # Unit tests only (no DB needed)
pnpm test:integration        # Integration tests only (requires DB)
pnpm test:coverage           # Run with coverage report
pnpm exec vitest run tests/path/to/file.test.ts  # Run a single test file
```

**Framework:** Vitest 4 with real PostgreSQL test database (`librariarr_test`), auto-created by global setup.

**Test structure:**

- `tests/setup/` — Global setup, test DB client, session mocks, data factories
- `tests/unit/` — Pure logic tests (rules engine, filters, sync detection, formatting, caching, validation schemas)
- `tests/integration/` — API route handler tests against real DB with mocked external services

**Key patterns:**

- Every integration test mocks `@/lib/db` to use test Prisma client and `@/lib/logger` to suppress DB writes
- External services (Plex, Sonarr, Radarr, Lidarr) are mocked via `vi.mock()`
- Auth is mocked via `setMockSession()` / `clearMockSession()` from `tests/setup/mock-session.ts`
- Constructor mocks must use `function()` keyword, not arrow functions (Vitest 4 requirement)
- Use `vi.hoisted()` when mock variables are referenced inside `vi.mock()` factory functions
- Route handlers are tested directly: `callRoute(GET, opts)` or `callRouteWithParams(POST, { id }, opts)`
- `expectJson<T>(response, status)` — parse response JSON + assert status in one call
- Data factories in `tests/setup/test-helpers.ts`: `createTestUser`, `createTestServer`, `createTestLibrary`, `createTestMediaItem`, `createTestRuleSet`, `createTestSonarrInstance`, `createTestRadarrInstance`, `createTestLidarrInstance`, `createTestSeerrInstance`, `createTestExternalId`, `createTestLogEntry`

**Config:** Tests run sequentially (`pool: "forks"`, `fileParallelism: false`) to prevent DB contention. Test timeout 15s, hook timeout 30s. Coverage scope: `src/lib/**/*.ts` and `src/app/api/**/*.ts` only.

## Architecture

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript · PostgreSQL 18 · Prisma 7 · Tailwind CSS v4 · shadcn/ui · Docker

### Route Structure

- `src/app/(authenticated)/` — All protected pages. Auth enforced by layout.tsx which validates session and redirects if invalid.
  - Dashboard (`/`), System Logs (`/system/logs`)
  - Settings (`/settings`) — `page.tsx` is the orchestrator (all state + handlers); 7 tab components in `settings/tabs/` are pure render receiving props; shared types in `settings/types.ts`; tab navigation via URL hash (`#general`, `#servers`, etc.)
  - Library: `/library/movies`, `/library/series` (with `/seasons` and `/episodes` sub-routes), `/library/music`
  - Lifecycle: `/lifecycle/rules` (unified rules page with Movies/Series/Music tabs), `/lifecycle/matches`, `/lifecycle/pending`, `/lifecycle/exceptions`
  - Tools: `/tools/streams` (Stream Manager: active sessions, maintenance mode, transcode manager, blackout schedules), `/tools/preroll` (Preroll Manager: presets, schedules, combine modes)
- `src/app/login/` and `src/app/onboarding/` — Public pages
- `src/app/api/` — API routes (all require authenticated session except auth endpoints)
  - `api/tools/sessions/` — Active session fetching, SSE streaming, termination, artwork proxy
  - `api/tools/maintenance/` — Maintenance mode toggle with configurable delay
  - `api/tools/transcode-manager/` — Transcode manager settings and criteria
  - `api/tools/blackout/` — Blackout schedule CRUD (one-time and recurring)
  - `api/tools/preroll/` — Preroll presets, schedules, path validation

### Key Libraries

- `src/lib/db.ts` — Prisma singleton (import as `@/lib/db`, NOT `@/lib/prisma`)
- `src/lib/auth/session.ts` — iron-session encrypted cookies (30-day expiry)
- `src/lib/validation.ts` — Zod schemas + `validateRequest` helper for all API mutation routes (see API Validation below)
- `src/lib/cache/memory-cache.ts` — In-process `MemoryCache` class with `appCache` singleton (see In-Memory Cache below)
- `src/lib/dedup/` — Multi-server dedup: `resolveServerFilter`, `server-presence` helpers (see Multi-Server Dedup below)
- `src/lib/filters/build-where.ts` — Shared filter query param parsing for media routes (see Filter Utilities below)
- `src/lib/plex/` — Plex OAuth flow and API client
- `src/lib/sync/sync-server.ts` — Media sync engine (fetches metadata from Plex)
- `src/lib/scheduler/` — node-cron scheduler, initialized via `instrumentation.ts`
- `src/lib/rules/` — Lifecycle rule engine with recursive AND/OR groups
- `src/lib/arr/` — Sonarr/Radarr/Lidarr API clients (15s timeout, title validation via `normalizeTitle()`)
- `src/lib/lifecycle/` — Detection (`detect-matches.ts`), action execution (`actions.ts`), orchestration (`processor.ts`), Plex collection sync (`collections.ts`), Arr/Seerr metadata fetching
- `src/lib/discord/client.ts` — Discord webhook notifications
- `src/lib/api/sanitize.ts` — `sanitize()` strips sensitive fields from API responses; `sanitizeErrorDetail()` scrubs internal paths/IPs from error messages (see Security below)
- `src/lib/rate-limit/rate-limiter.ts` — In-memory `RateLimiter` class; `authRateLimiter` singleton (10 attempts / 15 min) applied to auth endpoints
- `src/lib/logger.ts` — Structured logging with DB persistence: `logger` (backend), `apiLogger` (API), `dbLogger` (database). Logs to console and writes to `LogEntry` table. Debug logs require `LOG_DEBUG=true`
- `src/lib/backup/backup-service.ts` — Full DB backup/restore with optional AES-256-GCM encryption via passphrase
- `src/lib/theme/accent-colors.ts` — Theme accent color presets (OKLCH)
- `src/lib/maintenance/enforcer.ts` — Polls every 30s to enforce maintenance mode and transcode manager rules; initialized via `instrumentation.ts`

### Component Patterns

- `src/components/ui/` — shadcn/ui primitives (do not edit directly)
- Custom components: `authenticated-shell.tsx` (app shell with sidebar + global maintenance banner), `sidebar.tsx`, `media-table.tsx`, `media-filters.tsx`, `media-detail-panel.tsx`, `rule-builder.tsx`, `quality-chart.tsx`, `theme-provider.tsx`
- `src/hooks/` — Custom React hooks:
  - `useVirtualGridAlphabet` / `useTableAlphabet` — alphabet navigation for virtualized grid vs table views (not interchangeable); provide `scrollToLetter`, `activeLetter`, and `availableLetters`
  - `useScrollRestoration` — saves/restores scroll position via sessionStorage
  - `useCardSize` — S/M/L card size with localStorage persistence
  - `useServers` — fetches servers and manages selectedServerId state
  - `useColumnResize` — drag-to-resize table columns with mouse/touch support
  - `useIsMobile` — responsive breakpoint detection for sidebar/panel behavior

## Critical Conventions

### API Request Validation

All mutation routes use centralized Zod validation via `src/lib/validation.ts`:

```typescript
import { validateRequest, someSchema } from "@/lib/validation";
const { data, error } = await validateRequest(request, someSchema);
if (error) return error;
```

- All Zod schemas live in `src/lib/validation.ts` — do not define schemas inline in route files
- Uses `zod/v4` subpath import
- Returns `{ error: "Validation failed", details: [...] }` with status 400 on validation failure
- Returns `{ error: "Invalid JSON in request body" }` with status 400 on malformed JSON

### API Response Security

All API routes that return server/integration records must wrap responses in `sanitize()` from `src/lib/api/sanitize.ts`:

```typescript
import { sanitize } from "@/lib/api/sanitize";
return NextResponse.json({ server: sanitize(server) });
```

- Recursively masks `accessToken`, `apiKey`, `plexToken`, `passwordHash`, `backupEncryptionPassword` fields with `"••••••••"`
- Error responses use `sanitizeErrorDetail()` to strip internal file paths and private IPs
- Integration edit flows use server-side `[id]/test-connection` endpoints (POST to `/api/integrations/{type}/{id}/test-connection`) instead of sending stored API keys to the frontend
- Auth endpoints (login, Plex init/callback) are rate-limited via `authRateLimiter` — check before processing, return 429 with `Retry-After` header
- Media queries must verify ownership: use `findFirst` with `library: { mediaServer: { userId: session.userId } }` instead of bare `findUnique({ where: { id } })`

### API Pagination

Media list endpoints support pagination via query params:

- Query params: `page` (1-based, default 1), `limit` (default 50, capped at 100-200; `0` = return all), `sortBy`, `sortOrder`
- N+1 trick: fetch `limit + 1` items; if `items.length > limit`, pop last item and set `hasMore: true`
- Response shape: `{ items: [...], pagination: { page, limit, hasMore } }`
- `startsWith` param for server-side alphabet filtering (A-Z letters, or `#` for non-alpha titles)

**Frontend loading strategy:** Main library views (movies, series grouped, music artists) fetch all items at once (`limit=0`) and rely on `@tanstack/react-virtual` for rendering performance. Alphabet navigation uses client-side `scrollToLetter` from the alphabet hooks. Sub-views (seasons, episodes, tracks) still use paginated loading with limit 50.

### Multi-Server Dedup

When users connect multiple servers, dedup prevents duplicate items from appearing:

- `resolveServerFilter(userId, serverId, libraryType)` from `src/lib/dedup/server-filter.ts` — **required first step** for all media query routes. Returns `{ serverIds, isSingleServer, preferredTitleServerId, ... }`
- When `isSingleServer` is false, add `where.dedupCanonical = true` to filter to the preferred copy
- `dedupKey` is a normalized hash of item metadata; `dedupCanonical = true` marks the preferred copy across servers
- `getServerPresenceByDedupKey` (flat routes like movies) and `getServerPresenceByGroup` (grouped routes like series/music) attach a `servers[]` array showing which servers have each item

### In-Memory Cache

`appCache` from `src/lib/cache/memory-cache.ts` — in-process cache (no Redis), does not persist across restarts:

- `appCache.get<T>(key)`, `set(key, data, ttlMs?)`, `getOrSet(key, compute, ttlMs?)` (compute-and-cache)
- `invalidate(key)`, `invalidatePrefix(prefix)` (bulk invalidation by namespace), `clear()`
- Default 60s TTL
- Used by `resolveServerFilter`, available-letters endpoints, and other read-heavy paths

### Filter Utilities

`src/lib/filters/build-where.ts` centralizes all media filter logic:

- `applyCommonFilters(where, searchParams)` — mutates a `Prisma.MediaItemWhereInput` from standard query params
- Multi-select values: pipe-separated (`?resolution=4K|1080P`)
- Condition filters: `op:value` pairs with logic (`?yearConditions=gte:2020|lte:2024&yearLogic=and`)
- `applyStartsWithFilter(where, field, startsWith)` — handles `#` (non-alpha) and A-Z letter filtering

### Prisma and Database

- Always import Prisma as `import { prisma } from "@/lib/db"` (singleton pattern on globalThis)
- Prisma client generated to `src/generated/prisma` (custom output path, not the default)
- `fileSize` is stored as `BigInt` in PostgreSQL — serialize to string in API responses, convert back to number on frontend
- Production migration: `prisma migrate deploy` with fallback to `prisma db push`
- Dev migration: `prisma db push` (no migration files needed)

### Styling

- Tailwind CSS v4 with **OKLCH color model** (not HSL). CSS variables defined in `src/app/globals.css`
- Dark mode is hardcoded (`className="dark"` on `<html>` tag in layout.tsx)
- **Fonts:** Sora (display/headings via `font-display`), Plus Jakarta Sans (body via `font-sans`), JetBrains Mono (code via `font-mono`)
- All page `<h1>` elements must use `text-2xl sm:text-3xl font-bold font-display tracking-tight`
- Theme accent colors override CSS vars: `--primary`, `--primary-foreground`, `--ring`, `--sidebar-primary`
- shadcn/ui uses "new-york" style variant
- **Full style guide:** `docs/src/content/docs/docs/development/style-guide.mdx` — covers color palette, typography, effects, component patterns, and don'ts. Consult when making UI changes.

### Data Patterns

- TV series episodes are stored as individual `MediaItem` records with `parentTitle` as the series name, `seasonNumber`, and `episodeNumber`
- `LibraryType` enum: `MOVIE`, `SERIES`, or `MUSIC`
- External IDs (TMDB, TVDB, IMDB) stored in `MediaItemExternalId` table — used for Arr correlation
- Arr matching: Movies via TMDB ID → Radarr, Series via TVDB ID → Sonarr
- Dynamic range detection: normalizes to "Dolby Vision", "HDR10+", "HDR10", "HLG", or "SDR"
- Audio profile detection: normalizes to "Dolby Atmos", "Dolby TrueHD", "DTS-HD MA", "DTS:X", etc.

### Rule Engine

- Rules are recursive `RuleGroup` structures with AND/OR operators, stored as JSON in `RuleSet`
- Two-phase evaluation: Phase 1 converts rules to Prisma WHERE clauses, Phase 2 post-filters in memory for Arr/Seerr metadata, stream aggregation, and wildcard pattern matching
- File size rules: user inputs in GB, engine converts to bytes for DB queries

### Lifecycle Processing Workflow

The lifecycle system operates in three phases, orchestrated by `src/lib/lifecycle/processor.ts`:

**Phase 1 — Detection** (`detectAndSaveMatches` in `detect-matches.ts`):

- Two modes: **incremental** (default — adds new matches and removes stale ones) and **full re-evaluation** (atomic delete + recreate all matches)
- Incremental mode is used by the scheduler; full re-eval is triggered manually via "Re-evaluate All" button or when a rule set is edited (clears all matches so next run starts fresh)
- Items that no longer match are automatically removed from `RuleMatch` during incremental runs
- Fetches Arr/Seerr metadata lazily and caches per type (Movie/Series/Music) to share across rule sets
- Enriches items with `matchedCriteria`, `actualValues`, `arrId`, and `servers[]`
- For series with `seriesScope: false`, tracks individual episode IDs via `memberIds` in `itemData`

**Phase 2 — Action Scheduling** (in `processLifecycleRules`):

- Cancels pending `LifecycleAction` records for items no longer in matches (safety net for cascading deletes, rule set edits)
- Creates new `LifecycleAction` records with `scheduledFor = now + actionDelayDays` (only when `actionEnabled`)
- Prevents duplicate actions via `existingItemIds` check + `skipDuplicates: true`
- Syncs Plex collections from matched items when `collectionEnabled`

**Phase 3 — Execution** (`executeLifecycleActions`):

- Validates each pending action against `RuleMatch` table before executing (stale check)
- Tag operations execute first (add/remove Arr tags), then main action (delete, unmonitor, etc.)
- Title validation via `normalizeTitle()` prevents acting on wrong items when resolving Arr records
- `extractActionError()` extracts meaningful error messages from Arr API responses (HTTP status + response body)

**Rule set edit behavior**: Any PUT to a rule set clears all `RuleMatch` records and cancels all PENDING `LifecycleAction` records. The next detection run evaluates everything fresh.

### Notifications

- `src/lib/discord/client.ts` — Discord webhook notifications for lifecycle events (action success/failure, match count changes) and maintenance mode changes
- Notification failures never block lifecycle processing (wrapped in try-catch)

### Next.js Config

- `output: "standalone"` in next.config.ts (required for Docker builds)
- Path alias: `@/*` maps to `./src/*`

### Backup & Restore

- `createBackup(passphrase?, configOnly=true)` exports tables in FK dependency order, gzips, optionally encrypts with AES-256-GCM
- Config-only (default): skips `mediaItem`, `mediaItemExternalId`, `mediaStream`, `syncJob`, `logEntry` — these are repopulated by a full sync
- Full backup: includes all tables when `configOnly=false` (UI checkbox: "Include media data")
- Encrypted backups use `.json.gz.enc` extension; unencrypted use `.json.gz`
- `restoreBackup(filename, passphrase?, onProgress?)` truncates all tables in reverse FK order, then re-inserts in batches of 100; streams progress via NDJSON
- Sidecar `.meta.json` files store metadata (including `configOnly` flag) so `listBackups()` doesn't need to decompress files
- `getBackupPassphrase()` returns the saved encryption password from AppSettings (used by both manual and scheduled backups)
- Backup API POST falls back to the saved encryption password if no explicit passphrase is provided
- All persistent data paths are under `/config`: backups at `/config/backups`, image cache at `/config/cache/images`
- `BACKUP_DIR` and `IMAGE_CACHE_DIR` env vars can override the defaults

### Scheduler

- Initialized in `src/instrumentation.ts` (guarded by `NEXT_RUNTIME === "nodejs"` — skipped during Edge/build)
- Checks every minute for scheduled syncs and lifecycle rule processing
- Also starts the maintenance enforcer (30s polling loop) in the same `instrumentation.ts`

### Documentation Site

The `docs/` directory contains a static documentation website built with **Astro + Starlight**, deployed to GitHub Pages at `librariarr.dev`.

- Completely isolated from the Next.js app — separate `package.json`, `tsconfig.json`, and build toolchain
- Root `tsconfig.json` and `eslint.config.mjs` exclude `docs/` to prevent cross-contamination
- `.dockerignore` excludes `docs/` from Docker builds

```bash
pnpm docs:dev      # Start docs dev server (localhost:4321)
pnpm docs:build    # Production build
pnpm docs:preview  # Preview built docs
```

**Structure:**

- `docs/src/pages/index.astro` — Custom hero/landing page at `librariarr.dev/`
- `docs/src/content/docs/docs/` — MDX documentation at `librariarr.dev/docs/...`
- `docs/astro.config.mjs` — Sidebar structure, site config
- `docs/src/content.config.ts` — Astro 5 content collection config
- `.github/workflows/docs-deploy.yml` — GitHub Actions workflow (triggers on `docs/**` changes)

When adding features, update the relevant documentation in `docs/src/content/docs/docs/`.

### CI/CD

- `.github/workflows/ci.yml` — Lint, test, build on pushes to main and PRs
- `.github/workflows/docker-publish.yml` — Docker Hub image publish on main + version tags

### Git Conventions

- Husky pre-commit hook runs `pnpm exec eslint --quiet`
- Husky commit-msg hook enforces [Conventional Commits](https://www.conventionalcommits.org/) via commitlint (`@commitlint/config-conventional`)
- Commit format: `type(scope): description` — e.g. `feat: add stream manager`, `fix(auth): handle expired tokens`
