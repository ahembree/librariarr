# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Librariarr is a media library management webapp for Plex, Jellyfin, and Emby servers. It uses Plex OAuth for authentication, syncs media metadata from connected servers, provides filterable library browsing, and includes a lifecycle rule engine for automated media management.

**Librariarr is a single-user (single-admin) application.** Setup permits exactly one admin account, enforced by the `AppSettings.userId @unique` schema constraint and the setup gate in `src/app/api/auth/setup/route.ts`. A second user cannot exist. Do not add multi-tenant defensiveness — no per-user cache keys, no "cross-tenant leak" tests, no "tenant isolation" comments. See "Single-user model" under Critical Conventions for details.

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

**Test coverage requirement:** Every new or modified file under the coverage scope must have tests. In practice that means: every new route handler under `src/app/api/` gets an integration test in `tests/integration/`, and every new module under `src/lib/` gets a unit test in `tests/unit/`. Unit-level lib coverage is necessary but not sufficient — route handlers compose multiple lib modules with session state, validation, rate-limiting, and DB writes, and bugs hide in those seams. When the lib is fully covered but the route isn't, the route isn't tested.

### Browser E2E (Playwright)

Real-browser end-to-end tests live in `e2e/` (Playwright, **separate from Vitest** — `e2e/*.spec.ts`, never picked up by `vitest`). Config: `playwright.config.ts`.

- **Run it (portable, recommended):** `pnpm e2e:docker` — brings up `docker-compose.e2e.yml`: Postgres + the **real production app image** (built from `Dockerfile`) + the official `mcr.microsoft.com/playwright` image (browsers pre-baked, so **no browser download at run time**). The Playwright container sets `E2E_BASE_URL`, so `playwright.config.ts` skips its own web server and drives the app over the compose network.
- **Run it (host):** `pnpm build && pnpm e2e:install && pnpm e2e` (needs egress to `cdn.playwright.dev` for the one-time browser download).
- **CI:** `.github/workflows/e2e.yml` runs the compose stack on PRs (and `workflow_dispatch`).
- **Structure:** `e2e/global-setup.ts` pushes the schema (`prisma db push --url … --accept-data-loss` — Prisma 7 takes **no `--skip-generate`** on `db push`) and truncates a **dedicated `librariarr_e2e` DB** for a clean slate (so the app reports `setupRequired`). `e2e/auth.setup.ts` (the `setup` project) runs the real first-run flow to create the admin and saves `e2e/.auth/admin.json`; authenticated specs reuse it, `*-anon` specs use a cleared state. `e2e/constants.ts` holds the admin creds, the full page list (`PAGES`), the sidebar links (`NAV_LINKS`), and the settings tabs (`SETTINGS_TABS`). `e2e/seed.ts` seeds a minimal server→library→movie stack directly via `pg` for the data-dependent spec (single-server listings skip dedup-canonical filtering, so one item renders a populated view); seeding is idempotent and self-contained (clean before + after) so every other spec keeps its empty DB. Coverage: first-run setup, auth-guard redirects across all protected routes, the login page + local sign-in form; **every authenticated page and sub-route rendering** (`navigation.spec`); **sidebar** — every nav link, group labels, collapse persistence, search pill, user chip (`sidebar.spec`); **command palette** open/empty/Query-jump/Esc (`search-palette.spec`); **settings** — all seven tabs + per-tab content (servers/integrations/notifications/auth/system/scheduling) + accent persistence (`settings.spec`); **library** — empty states, card/table toggle, series & music sub-tab navigation, History + Query workspaces (`library.spec`); **lifecycle** — rules tabs/builder, matches/pending/exceptions empty states, status filters, add-exception dialog (`lifecycle.spec`); **tools** — stream-manager sections + blackout dialog, preroll sections + preset/schedule dialogs (`tools.spec`); **system logs** filters (`logs.spec`); **dashboard** greeting/zones/customize (`dashboard.spec`); **mobile** drawer navigation (`mobile.spec`); **populated views** — seeded movie in list/table/detail + settings server list (`seeded-library.spec`); and logout + local re-login. **Run-local caveat:** the host path needs egress to `cdn.playwright.dev` for the browser download — when that's blocked, use `pnpm e2e:docker` (browsers pre-baked).
- **Excluded from the production image:** `@playwright/test` is a devDependency (not traced into the Next.js standalone output); `.dockerignore` also excludes `e2e/`, `playwright.config.ts`, and reports; `tsconfig`/`eslint` exclude `e2e/`. **Keep the compose Playwright image tag in sync with the `@playwright/test` version** in `package.json`.

## Architecture

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript · PostgreSQL 18 · Prisma 7 · Tailwind CSS v4 · shadcn/ui · Docker

### Route Structure

- `src/app/(authenticated)/` — All protected pages. Auth enforced by layout.tsx which validates session and redirects if invalid.
  - Dashboard (`/`), System Logs (`/system/logs`)
  - Settings (`/settings`) — `page.tsx` is the orchestrator (all state + handlers); 7 tab components in `settings/tabs/` are pure render receiving props; shared types in `settings/types.ts`; tab navigation via URL hash (`#general`, `#servers`, etc.)
  - Library: `/library/movies`, `/library/series` (with `/seasons` and `/episodes` sub-routes), `/library/music`
  - Lifecycle: `/lifecycle/rules` (unified rules page with Movies/Series/Music tabs), `/lifecycle/matches`, `/lifecycle/pending`, `/lifecycle/exceptions`
  - Tools: `/tools/streams` (Stream Manager: active sessions, maintenance mode, transcode manager, blackout schedules), `/tools/preroll` (Preroll Manager: presets, schedules, combine modes), `/tools/trash` (TRaSH Guide Sync: import custom formats / quality profiles / quality sizes / naming from trash-guides.info into Sonarr/Radarr with an explicit per-item consent gate, diff preview, and dry-run)
- `src/app/login/` and `src/app/onboarding/` — Public pages
- `src/app/api/` — API routes (all require authenticated session except auth endpoints)
  - `api/tools/sessions/` — Active session fetching, SSE streaming, termination, artwork proxy
  - `api/tools/maintenance/` — Maintenance mode toggle with configurable delay
  - `api/tools/transcode-manager/` — Transcode manager settings and criteria
  - `api/tools/blackout/` — Blackout schedule CRUD (one-time and recurring)
  - `api/tools/preroll/` — Preroll presets, schedules, path validation
  - `api/tools/trash/` — TRaSH Guide Sync: `instances` (Sonarr/Radarr picker), `catalog` (guide fetch + naming variants + custom-format list), `profiles` (the instance's quality profiles + current CF scores, plus `instanceFormatNames` — every CF name present in the app, so the UI can flag an assigned format that isn't in the app yet), `status` (per-item cross-reference), `assignments` (the consent gate — opt resources into management), `sync` (dry-run/diff or apply, writes only managed resources). Resource types: `CUSTOM_FORMAT`, `QUALITY_PROFILE`, `QUALITY_DEFINITION`, `NAMING`, and `PROFILE_CF` (overlay guide custom-format scores onto any quality profile — keyed by profile name, non-destructive to the rest of the profile)

### Key Libraries

- `src/lib/db.ts` — Prisma singleton (import as `@/lib/db`, NOT `@/lib/prisma`)
- `src/lib/auth/session.ts` — iron-session encrypted cookies (30-day expiry)
- `src/lib/validation.ts` — Zod schemas + `validateRequest` helper for all API mutation routes (see API Validation below)
- `src/lib/cache/memory-cache.ts` — In-process `MemoryCache` class with `appCache` singleton (see In-Memory Cache below)
- `src/lib/dedup/` — Multi-server dedup: `resolveServerFilter`, `server-presence` helpers (see Multi-Server Dedup below)
- `src/lib/filters/build-where.ts` — Shared filter query param parsing for media routes (see Filter Utilities below)
- `src/lib/plex/` — Plex OAuth flow and API client
- `src/lib/sso/` — OIDC (Authorization Code + PKCE) and forward-auth helpers. Manual-linking only: an admin must link an `ssoSubject` to a User before SSO login is accepted. When `AppSettings.ssoEnabled` is true, the local username/password form is hidden on the login page (Plex login remains by default). `AppSettings.plexLoginEnabled` (default true) independently controls whether the Plex login button is shown — toggling it off hides Plex from the login page without unlinking the Plex token from the User record (so server discovery and library sync still work). `/api/settings/auth` enforces a unified lockout guard: at least one of Plex login, local auth, or SSO must remain usable post-update.
- `src/lib/sync/sync-server.ts` — Media sync engine (fetches metadata from Plex)
- `src/lib/jobs/` — [Graphile Worker](https://worker.graphile.org/) background job queue (Postgres-backed), initialized via `instrumentation.ts`. `worker.ts` runs the in-process worker + static crontab; `dispatch.ts` is the per-minute dispatcher that fans DB-configured schedules into durable jobs; `tasks.ts` holds the task handlers; `client.ts` exposes `enqueueJob()`; `schedule.ts` has the pure cron/preset helpers (`presetToCron`, `isScheduleDue`, `getSystemTimezone`)
- `src/lib/rules/` — Lifecycle rule engine with recursive AND/OR groups
- `src/lib/arr/` — Sonarr/Radarr/Lidarr API clients (15s timeout, title validation via `normalizeTitle()`)
- `src/lib/trash/` — TRaSH Guide Sync engine: `catalog.ts` fetches + caches the guide JSON (from `raw.githubusercontent.com`, overridable via `TRASH_GUIDES_REPO`/`TRASH_GUIDES_REF`); `arr-guide-client.ts` is a focused Sonarr/Radarr v3 client for custom-format/quality-profile/quality-definition/naming endpoints (separate from `src/lib/arr` core clients); `translate.ts` converts guide JSON → Arr payloads (pure, unit-tested — CF field object→array, quality-profile builder resolving qualities/groups/cutoff/CF-scores against the live schema, plus per-profile options mirroring Recyclarr — `scoreSet` override and opt-in `resetUnmatchedScores` with exact-name/regex exceptions, both stored on the QUALITY_PROFILE managed row's `selection`; size + naming appliers); `diff.ts` + `signature.ts` power the change preview and upstream-change detection; `status.ts` cross-references guide↔instance↔managed rows; `sync.ts` builds the plan and applies it. **Consent gate**: nothing is written to an Arr app for a resource without a `TrashManagedResource` row; `sync.ts` only ever writes managed resources (dry-run `items` are preview-only), and taking over an item that already exists requires explicit confirmation in the UI
- `src/lib/lifecycle/` — Detection (`detect-matches.ts`), action execution (`actions.ts`), orchestration (`processor.ts`), Plex collection sync (`collections.ts` — `syncCollection` unions contributions, `syncCollectionById`/`syncAllCollections` drive it from persisted matches), Arr/Seerr metadata fetching
- `src/lib/discord/client.ts` — Discord webhook notifications
- `src/lib/api/sanitize.ts` — `sanitize()` strips sensitive fields from API responses; `sanitizeErrorDetail()` scrubs internal paths/IPs from error messages (see Security below)
- `src/lib/rate-limit/rate-limiter.ts` — In-memory `RateLimiter` class; `authRateLimiter` singleton (10 attempts / 15 min) applied to auth endpoints
- `src/lib/logger.ts` — Structured logging with DB persistence: `logger` (backend), `apiLogger` (API), `dbLogger` (database). Logs to console and writes to `LogEntry` table. Debug logs require `LOG_DEBUG=true`
- `src/lib/backup/backup-service.ts` — Full DB backup/restore with optional AES-256-GCM encryption via passphrase
- `src/lib/theme/accent-colors.ts` — Theme accent color presets (OKLCH)
- `src/lib/maintenance/enforcer.ts` — Polls every 30s to enforce maintenance mode and transcode manager rules; initialized via `instrumentation.ts`

### Component Patterns

- `src/components/ui/` — shadcn/ui primitives (do not edit directly)
- Custom components: `authenticated-shell.tsx` (app shell with sidebar, mobile glass header + drawer, global maintenance banner), `sidebar.tsx`, `media-table.tsx`, `media-filters.tsx`, `media-detail-panel.tsx`, `rule-builder.tsx`, `quality-chart.tsx`, `theme-provider.tsx`, `dashboard/` (fixed dashboard zones: `status-strip.tsx`, `library-tiles.tsx`, `lifecycle-pipeline.tsx`; the customizable Insights grid below them still uses `dashboard-card-grid.tsx` + `card-registry.ts`)
- Hover popovers (`MediaHoverPopover`) must always pass the same universal set of fields regardless of page or view type — documented in `docs/src/content/docs/docs/development/style-guide.mdx` under "Hover Popovers". Table and card views within the same page must always pass identical fields.
- `src/hooks/` — Custom React hooks:
  - `useVirtualGridAlphabet` / `useTableAlphabet` — alphabet navigation for virtualized grid vs table views (not interchangeable); provide `scrollToLetter`, `activeLetter`, and `availableLetters`
  - `useScrollRestoration` — saves/restores scroll position via sessionStorage
  - `useCardSize` — S/M/L card size with localStorage persistence
  - `useServers` — fetches servers and manages selectedServerId state
  - `useColumnResize` — drag-to-resize table columns with mouse/touch support
  - `useIsMobile` — responsive breakpoint detection for sidebar/panel behavior

## Critical Conventions

### Single-user model

Librariarr runs with exactly one admin account. This is enforced by:

- **Schema**: `AppSettings.userId @unique` in `prisma/schema.prisma` — the DB rejects a second admin row.
- **Setup gate**: `src/app/api/auth/setup/route.ts` and `src/app/api/auth/plex/token/route.ts` reject creating a second user (see the "single-admin app" comment in the latter).
- **Check-setup**: `src/app/api/auth/check-setup/route.ts` uses `findFirst()` because there is one and only one admin.

Code references `session.userId` because per-user resources (`MediaServer`, `RuleSet`, `LifecycleAction`, etc.) carry a `userId` FK — that's a normal Prisma relation, not a signal that more than one user could be present concurrently. **Never** add per-user cache keys, multi-tenant invalidation patterns, or "no cross-tenant leak" tests. If you find yourself writing one, stop and reread this section.

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

- `appCache.get<T>(key)`, `set(key, data, ttlMs?)`, `getOrSet(key, compute, ttlMs?)` (compute-and-cache, **single-flight**: concurrent misses for the same key share one `compute()` call)
- `invalidate(key)`, `invalidatePrefix(prefix)` (bulk invalidation by namespace), `clear()`
- Default 60s TTL; the store is **bounded** (evicts expired-then-oldest past `maxEntries`) so a long-running process can't grow unbounded
- Used by `resolveServerFilter`, available-letters endpoints, and other read-heavy paths
- **Always call `invalidateMediaCaches()` from `src/lib/cache/invalidate.ts`** after any mutation that changes media items, server membership, dedup canonical selection, or title/artwork preference — it drops every media-derived prefix (`server-filter:`, `stats:`, `letters:`, `group-summary:`, `cross-tab:`, `custom-stats:`, `timeline:`, `distinct-values`, `watch-history-filters:`) in one call. Used by sync, purge, server CRUD, and the dedup/title-preference settings routes. Do not hand-roll partial invalidation — it's the recurring source of stale-listing bugs.

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
- Production migration: `prisma migrate deploy` then `prisma db push` (entrypoint always runs both — `migrate deploy` applies migration files, `db push` applies schema-only column additions)
- Dev migration: `prisma db push` (no migration files needed)

### Styling

- Tailwind CSS v4 with **OKLCH color model** (not HSL). CSS variables defined in `src/app/globals.css`
- Dark mode is hardcoded (`className="dark"` on `<html>` tag in layout.tsx)
- **Fonts:** Sora (display/headings via `font-display`), Plus Jakarta Sans (body via `font-sans` — applied on `body` in globals.css; next/font vars live on `<body>` so preflight's `html` rule can't see them), JetBrains Mono (code via `font-mono`)
- All page `<h1>` elements must use `text-2xl sm:text-3xl font-bold font-display tracking-tight`
- Theme accent colors override CSS vars: `--primary`, `--primary-foreground`, `--ring`, `--sidebar-primary`. Preset names are persisted in `AppSettings.accentColor` — never rename them
- shadcn/ui uses "new-york" style variant
- **Mobile / PWA:** installable (`src/app/manifest.ts`, theme color `#0c0d10`, `viewport-fit=cover`). Below `md` (768px) the shell swaps the sidebar for a glass header whose hamburger opens the navigation drawer. Safe-area utilities: `.pt-safe`, `.pb-safe` (notch/home-indicator padding in standalone mode)
- **Full style guide:** `docs/src/content/docs/docs/development/style-guide.mdx` — covers color palette, typography, effects, component patterns, and don'ts. Consult when making UI changes.

### Data Patterns

- TV series episodes are stored as individual `MediaItem` records with `parentTitle` as the series name, `seasonNumber`, and `episodeNumber`
- `LibraryType` enum: `MOVIE`, `SERIES`, or `MUSIC`
- External IDs (TMDB, TVDB, IMDB) stored in `MediaItemExternalId` table — used for Arr correlation
- Arr matching: Movies via TMDB ID → Radarr, Series via TVDB ID → Sonarr
- Dynamic range detection: normalizes to "Dolby Vision", "HDR10+", "HDR10", "HLG", or "SDR"
- Audio profile detection: normalizes to "Dolby Atmos", "Dolby TrueHD", "DTS-HD MA", "DTS:X", etc.

### Rule Engine

- Rules are recursive `RuleGroup` structures with AND/OR operators, stored as JSON in `RuleSet`. Rules and groups support `negate`; group-level negation is normalized away before evaluation by `pushDownGroupNegation` (`src/lib/conditions/negation.ts`, De Morgan push-down into per-rule negation) so both evaluation phases share NULL semantics
- Two-phase evaluation: Phase 1 converts rules to Prisma WHERE clauses, Phase 2 post-filters in memory for Arr/Seerr metadata, stream aggregation, and wildcard pattern matching
- **The lifecycle rule engine (`src/lib/rules/lifecycle-engine.ts`) and the query builder (`src/lib/query/query-engine.ts`) share one implementation of both phases** so they can't drift: Phase 1 goes through the single `ruleToWhere` dispatcher in `src/lib/conditions/where-builder.ts` (both engines pass it to `buildGroupConditions`), and Phase 2 Arr/Seerr evaluation uses the exported `evaluateArrRule`/`evaluateSeerrRule` from `lifecycle-engine.ts` (the query side's `query/arr-filter.ts` / `query/seerr-filter.ts` are thin re-export shims). Phase 2 evaluation of the JSON-array fields (`genre`, `labels`, `country`) goes through the shared `matchArrayField` in `src/lib/conditions/array-field-eval.ts` — **case-insensitive** for all operators (regression-tested as "Bug 5"), matching the scalar-text convention. The two engines previously carried divergent inline copies (the query side compared case-sensitively), so keep this one shared. When fixing operator/NULL semantics, fix it once in these shared functions.
- File size rules: user inputs in MB, engine converts to bytes for DB queries
- **Series-aggregate fields** (`episodeCount`, `watchedEpisodePercentage`, …) can only be evaluated against an aggregated series record, never per-episode. A SERIES rule referencing one is routed through the aggregate path (`evaluateSeriesScope` in lifecycle, `aggregateSeriesAndFilter` in query) **regardless of `seriesScope`** — `hasSeriesAggregateRules` is part of the Phase-1 gate in both engines so the aggregate conjunct is never silently dropped from `where-builder` (which returns `{}` for aggregate fields)

### Lifecycle Processing Workflow

The lifecycle system operates in three phases, orchestrated by `src/lib/lifecycle/processor.ts`:

**Phase 1 — Detection** (`detectAndSaveMatches` in `detect-matches.ts`):

- Two modes: **incremental** (default — adds new matches and removes stale ones) and **full re-evaluation** (atomic delete + recreate all matches)
- Incremental mode is used by the scheduler; full re-eval is triggered manually via "Re-evaluate All" button or when a rule set is edited (clears all matches so next run starts fresh)
- Items that no longer match are automatically removed from `RuleMatch` during incremental runs
- Fetches Arr/Seerr metadata lazily and caches per type (Movie/Series/Music) to share across rule sets
- **Evaluability guard** (`src/lib/lifecycle/evaluability.ts` — the single policy point): a rule set whose rules use Arr fields is skipped (warning logged, matches untouched) when no enabled instance of the matching Arr family exists — evaluating against an empty metadata map would make `foundInArr = false` vacuously true for the entire library. Same for Seerr fields with no enabled Seerr instance. Seerr fields on MUSIC rule sets are **permanently** unevaluable (Seerr data is never fetched for music; the fields also carry `invalidForLibraryType: ["MUSIC"]` so create/update rejects them) — detection additionally **disarms** such rule sets (clears `RuleMatch`, cancels PENDING actions) and `executeLifecycleActions` cancels their actions as a backstop, so a vacuous flood armed before the guard existed can never fire. `processLifecycleRules`, `runDetection`, and (defense-in-depth) `detectAndSaveMatches` itself enforce this via `checkLifecycleRuleEvaluability`; the preview/test-item/diff routes return its reason as a 400. The ad-hoc query-actions route has the analogous guard: it refuses to act when the query's Arr rules have no selected/existing Arr server for the action's media type, or Seerr rules with no enabled selected instance (or a MUSIC action)
- Enriches items with `matchedCriteria`, `actualValues`, `arrId`, and `servers[]`
- For series with `seriesScope: false`, tracks individual episode IDs via `memberIds` in `itemData`
- **Multi-server**: when a rule set targets more than one server, matches that resolve to the same Arr record (same TMDB/TVDB/MBID) are collapsed by `arrId` (merging `servers[]`) so the same title doesn't schedule two destructive actions or double-count `deletedBytes`. Dedup is by Arr id (not `dedupCanonical`) because a rule set may target a server subset whose canonical copy lives on a non-targeted server

**Phase 2 — Action Scheduling** (in `processLifecycleRules`):

- Cancels pending `LifecycleAction` records for items no longer in matches (safety net for cascading deletes, rule set edits)
- Creates new `LifecycleAction` records with `scheduledFor = now + actionDelayDays` (only when `actionEnabled`)
- Skips scheduling for an item that already has a PENDING action (dedup) **or** a COMPLETED/FAILED action with the **same config signature** as the one being scheduled (`actionConfigSignature` in `src/lib/lifecycle/action-signature.ts` — action type + Arr instance + quality profile + tags-as-sets + flags; deliberately excludes `actionDelayDays`). This stops non-destructive actions (unmonitor/do-nothing/search/quality-change) re-firing every cycle on a still-matching item, while still letting a **changed or re-configured** action re-fire (different signature → never run before). Destructive (`DELETE*`) actions are always re-schedulable (a still-matching item after a "completed" delete likely failed silently). `skipDuplicates: true` guards concurrent runs. The **same** signature guard drives the Pending page's "estimated" rows (`GET /api/lifecycle/actions`) and the pending-deletion-bytes estimate (`GET /api/lifecycle/stats`), so Matches, Pending, and stats stay consistent
- After **all** rule sets are processed, `processLifecycleRules` calls `syncAllCollections(userId)` **once** to push Plex collections (see Plex Collections below) — never per rule set, because a collection's membership is the union of every rule set feeding it

**Phase 3 — Execution** (`executeLifecycleActions`):

- Validates each pending action against `RuleMatch` table before executing (stale check)
- **Whole-record exception guard** (`src/lib/lifecycle/exception-guard.ts`): a whole-record destructive action (`DELETE_SONARR`/`DELETE_LIDARR` — destroys every episode/track, not just matched members) is cancelled when ANY item of the same `parentTitle`+type carries a `LifecycleException`, even one the rule never matched (the member-based inviolability check only sees `matchedMediaItemIds`). Enforced in the scheduled executor (protected parents batch-resolved once per run, skipped entirely when the user has no exceptions), the manual execute route, force-retry, and the query-page actions route
- Tag operations execute first (add/remove Arr tags), then main action (delete, unmonitor, etc.)
- Title validation via `normalizeTitle()` prevents acting on wrong items when resolving Arr records
- `extractActionError()` extracts meaningful error messages from Arr API responses (HTTP status + response body)
- Completed actions record `deletedBytes` (from `MediaItem.fileSize` or sum of member items) for deletion stats tracking
- Deletion stats are aggregated via `GET /api/lifecycle/stats`; reset via `POST /api/lifecycle/stats/reset` (sets `AppSettings.deletionStatsResetAt`)

**Rule set edit behavior**: Any PUT to a rule set clears all `RuleMatch` records and cancels all PENDING `LifecycleAction` records. The next detection run evaluates everything fresh.

### Plex Collections (merge)

A `Collection` is a reusable, named Plex-collection definition (`prisma/schema.prisma`) owning the presentation settings (`name`, `sortName`, `homeScreen`, `recommended`, `sort`) and scoped to one `LibraryType`. A `RuleSet` references it via the optional `collectionId` FK (`onDelete: SetNull`). Multiple rule sets can point at the **same** collection — "merge".

- **Union membership**: `syncCollection(collection, contributions, cache)` in `src/lib/lifecycle/collections.ts` sets the Plex collection's membership to the **union** of every contributing rule set's matched items. Never sync a collection per rule set — that's how the pre-merge code clobbered shared collections.
- **Driven from `RuleMatch`**: `syncCollectionById(id)` builds contributions from the persisted matches of every enabled rule set assigned to the collection (`buildContributionsFromMatches`), so re-evaluating one rule still syncs against all of them, and orphaned collections resolve to an empty union (which removes the Plex collection). `syncAllCollections(userId?)` does this for every collection in scope and **replaces** the old per-rule "disabled collection cleanup" pass.
- **Ordering**: `ACTION_DATE` sort pools the PENDING `LifecycleAction` rows of **all** contributing rule sets, so scheduled-action order is correct across rules. Collection sync therefore runs **after** action scheduling (`processLifecycleRules` after its loop; the manual `runDetection` path via `syncCollectionsAfterDetection` called from `/api/lifecycle/rules/run` after `scheduleActionsForRuleSet`).
- **CRUD**: `GET/POST /api/lifecycle/collections`, `PUT/DELETE /api/lifecycle/collections/[id]` (PUT renames on Plex + re-syncs; DELETE removes from Plex + `SetNull` detaches rules), `POST /api/lifecycle/collections/sync` (`{ collectionId }`). Managed inline from the lifecycle rule editor's collection dropdown — settings edit the shared collection. There is no `collectionEnabled`/`collectionName`/inline-settings on `RuleSet` anymore (migration `0010_add_collections` backfills + auto-merges same `(userId, type, name)`).

### Notifications

- `src/lib/discord/client.ts` — Discord webhook notifications for lifecycle events (action success/failure, match count changes) and maintenance mode changes
- Notification failures never block lifecycle processing (wrapped in try-catch)

### Next.js Config

- `output: "standalone"` in next.config.ts (required for Docker builds)
- Path alias: `@/*` maps to `./src/*`

### Backup & Restore

- `createBackup(passphrase?, configOnly=true)` exports tables in FK dependency order, gzips, optionally encrypts with AES-256-GCM
- Config-only (default): skips `mediaItem`, `mediaItemExternalId`, `mediaStream`, `syncJob`, `ruleMatch`, `lifecycleAction`, `lifecycleException`, `watchHistory`, `logEntry` — these are repopulated by sync and lifecycle processing
- Full backup: includes all tables when `configOnly=false` (UI checkbox: "Include media data")
- Encrypted backups use `.json.gz.enc` extension; unencrypted use `.json.gz`
- `restoreBackup(filename, passphrase?, onProgress?)` truncates all tables in reverse FK order, then re-inserts in batches of 100; streams progress via NDJSON
- Sidecar `.meta.json` files store metadata (including `configOnly` flag) so `listBackups()` doesn't need to decompress files
- `getBackupPassphrase()` returns the saved encryption password from AppSettings (used by both manual and scheduled backups)
- Backup API POST falls back to the saved encryption password if no explicit passphrase is provided
- All persistent data paths are under `/config`: backups at `/config/backups`, image cache at `/config/cache/images`
- `BACKUP_DIR` and `IMAGE_CACHE_DIR` env vars can override the defaults

### Background Jobs (Graphile Worker)

- Background work runs through [Graphile Worker](https://worker.graphile.org/), a Postgres-backed job queue. The worker runs **in-process** (not a separate container), started from `src/instrumentation.ts` (guarded by `NEXT_RUNTIME === "nodejs"` — skipped during Edge/build). `startWorker()` is awaited so the worker's own migrations (the `graphile_worker` schema, created automatically — the DB role needs `CREATE` privilege) are applied before any request can enqueue a job. This schema is separate from Prisma's `public` schema; `prisma db push` never touches it.
- **Orphaned-lock recovery on boot**: before the runner starts, `startWorker()` calls `recoverOrphanedWorkerLocks()` to null out any `locked_at`/`locked_by` on the `graphile_worker._private_job_queues` and `_private_jobs` rows. A hard kill mid-job (container restart, crash, OOM) leaves the `MAIN_QUEUE` row locked by a now-dead worker, and `getJob` will not run **any** job on a locked queue — so without this recovery every sync, lifecycle run, and backup stalls until graphile-worker's built-in stale-lock sweep clears it **4 hours** later (the "restart mid-sync ⇒ syncs stop working" bug). Because librariarr runs exactly one in-process worker, any lock present at boot is necessarily orphaned, so clearing unconditionally is safe; it must run before the runner so it can't race a lock the new worker just acquired. This is separate from `cleanupOrphanedSyncJobs()`, which only fixes the app's own `SyncJob` rows, not the queue lock.
- A static crontab (`src/lib/jobs/worker.ts`) drives recurring tasks: the **dispatcher** runs every minute, action cleanup every 15 minutes, log archival hourly.
- The **dispatcher** (`dispatch.ts`) reads the user-configured, DB-stored schedules (`AppSettings.syncSchedule`, `lifecycleDetectionSchedule`, etc.), advances the `lastScheduled*` timestamp, and enqueues durable jobs for any work that is due. Heavy domain jobs (sync, lifecycle detection/execution, backup) share the serial `MAIN_QUEUE` so they run one-at-a-time (mirroring the original sequential scheduler); the dispatcher and housekeeping tasks omit a queue so a long sync never blocks scheduling. Jobs use a `jobKey` to deduplicate and are retried with backoff on failure.
- Manual/API sync triggers (`/api/servers/[id]/sync`, `/api/sync/by-type`) enqueue durable `sync-server` jobs via `enqueueJob()` instead of fire-and-forget calls. `syncMediaServer` still self-serializes via its internal semaphore (`sync-semaphore.ts`), which guards all callers including the inline lifecycle re-sync.
- Manual "Run Now" triggers (`/api/settings/schedule-info/run`) for **detection** and **execution** also enqueue durable jobs on `MAIN_QUEUE` with a stable `jobKey` (`detection:<userId>` / `execution:<userId>`) rather than running inline, so a double-click or a collision with the per-minute dispatcher dedupes into one run. The schedule watermark (`lastScheduled*`/`lastBackupAt`) is advanced only **after** a successful enqueue (in both the dispatcher and the manual route) so a transient enqueue failure can't silently skip a window.
- Also starts the maintenance/preroll enforcers (30s `setInterval` polling loops) in the same `instrumentation.ts` — these keep cross-tick in-memory state and sub-minute cadence, so they intentionally remain outside the job queue.

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

### Documentation Maintenance

When adding features or changing behavior, **always update the corresponding documentation** in `docs/src/content/docs/docs/` within the same PR. Documentation and code must stay in sync. Specifically:

- **New features**: Add or update the relevant page under `docs/src/content/docs/docs/features/` or `docs/src/content/docs/docs/integrations/`
- **Changed defaults, env vars, or config options**: Update `docs/src/content/docs/docs/getting-started/configuration.mdx` and `docs/src/content/docs/docs/getting-started/installation.mdx`
- **API changes**: Update any docs that reference the affected endpoints or behavior
- **Schema changes**: If Prisma models change in ways that affect user-facing behavior (new fields, changed defaults, removed tables), update the relevant feature docs
- **Scheduler/timing changes**: Update both this file (CLAUDE.md) and any feature docs that reference polling intervals, cron schedules, or processing frequency
- **Rule engine changes**: Update `docs/src/content/docs/docs/features/lifecycle-rules.mdx` — field lists, operators, action types, and units must match the code
- **CLAUDE.md itself**: When implementation details described in this file change (architecture, conventions, defaults, file paths), update this file too

Documentation files to be aware of:

| Area | Documentation file |
|------|--------------------|
| Installation & env vars | `getting-started/installation.mdx`, `getting-started/configuration.mdx` |
| Server setup | `getting-started/connecting-a-server.mdx` |
| Library browsing & filters | `features/library.mdx` |
| Lifecycle rules & actions | `features/lifecycle-rules.mdx` |
| Backup & restore | `features/backup-restore.mdx` |
| Notifications | `features/notifications.mdx` |
| Stream manager & maintenance | `features/stream-manager.mdx` |
| Preroll manager | `features/preroll-manager.mdx` |
| TRaSH Guide Sync | `features/trash-guide-sync.mdx` |
| System logs | `features/system-logs.mdx` |
| Integrations | `integrations/plex.mdx`, `integrations/jellyfin-emby.mdx`, `integrations/sonarr.mdx`, `integrations/radarr.mdx`, `integrations/lidarr.mdx`, `integrations/seerr.mdx` |
| Unraid | `getting-started/unraid.mdx` |
| Style guide | `development/style-guide.mdx` |
| Security | `advanced/security-hardening.mdx` |
| Development | `advanced/development.mdx` |

### CI/CD

- `.github/workflows/ci.yml` — Lint, test, build on pushes to main and PRs
- `.github/workflows/release-please.yml` — On push to main, runs release-please; when a release is created, builds and pushes the Docker image with `latest` + semver tags
- `.github/workflows/docker-nightly.yml` — On push to `main` (or manual dispatch), builds and pushes the `nightly` rolling tag + immutable `nightly-<sha>` tags for the trunk-based bleeding-edge channel. Never publishes `latest`/semver (reserved for releases)
- `.github/workflows/docker-publish.yml` — Manual (`workflow_dispatch`) Docker Hub image publish
- `.github/workflows/pr-title-lint.yml` — Validates every PR **title** against Conventional Commits (mirrors `@commitlint/config-conventional`). Because squash-merging uses the PR title as the commit subject on `main`, and release-please classifies commits by that subject, a non-conventional title would be silently dropped from the release/changelog. The local `commit-msg` hook can't catch a title typed into GitHub's merge UI, so this check enforces it server-side.

### Git Conventions

- Husky pre-commit hook runs `pnpm exec eslint --quiet`
- Husky commit-msg hook enforces [Conventional Commits](https://www.conventionalcommits.org/) via commitlint (`@commitlint/config-conventional`)
- Commit format: `type(scope): description` — e.g. `feat: add stream manager`, `fix(auth): handle expired tokens`
- **When squash-merging a PR, the PR title becomes the commit subject on `main` — it MUST be a valid Conventional Commit** (enforced by `pr-title-lint.yml`). release-please reads that subject to decide the version bump and changelog; a squashed PR titled `Add X` (not `feat: add X`) is dropped from the release entirely. Merge-commit PRs are safe because release-please reads the inner commits, but squash collapses them into the one title.
