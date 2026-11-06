# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. It states the rules and where things live; the reasoning and incident history behind each rule live in code comments and git history (`git log -S '<symbol>'`).

## Project Overview

Librariarr is a media library management webapp for Plex, Jellyfin, and Emby servers. It signs in with Plex OAuth (or local password / SSO), syncs media metadata from connected servers, provides filterable library browsing, and includes a lifecycle rule engine for automated media management (including deletion through Sonarr/Radarr/Lidarr).

**Librariarr is a single-user (single-admin) application.** Setup permits exactly one admin account (`AppSettings.userId @unique`, setup gate in `src/app/api/auth/setup/route.ts`). Do not add multi-tenant defensiveness — see "Single-user model".

## Commands

```bash
# Development (Docker-based, preferred)
pnpm docker:dev          # Start dev environment (foreground)
pnpm docker:dev:detach   # Start dev environment (background)
pnpm docker:dev:down     # Stop dev environment
pnpm docker:dev:rebuild  # Rebuild containers from scratch
pnpm docker:dev:clean    # Stop containers and delete DB volume
pnpm docker:dev:logs     # Tail dev container logs

# Database
pnpm docker:dev:db:push    # Push schema changes (no migration files)
pnpm docker:dev:db:migrate # Run Prisma migrations
pnpm docker:dev:db:studio  # Open Prisma Studio
pnpm docker:dev:db:reset   # Reset DB completely

# Build and lint
pnpm build                 # Next.js production build (also type-checks tests/)
pnpm lint                  # ESLint
pnpm exec prisma generate  # Regenerate Prisma client without a DB

# Tests (integration tests need the Docker DB: pnpm docker:dev:detach)
pnpm test                  # Full suite
pnpm test:watch            # Watch mode
pnpm test:unit             # Unit tests only (no DB)
pnpm test:integration      # Integration tests only
pnpm test:coverage         # With coverage report
pnpm exec vitest run tests/path/to/file.test.ts
```

### Testing

Vitest 4 against a real PostgreSQL test database (`librariarr_test`, auto-created by global setup).

- `tests/setup/` — global setup, test DB client, session mocks, data factories. `tests/unit/` — pure logic. `tests/unit/hooks/` — React hooks: each file starts with `// @vitest-environment happy-dom` and uses `renderHook`/`act` from `@testing-library/react` (the rest of the suite runs in `node`). `tests/integration/` — route handlers against the real DB with external services mocked.
- Every integration test mocks `@/lib/db` (test Prisma client) and `@/lib/logger`. External services (Plex, Sonarr, Radarr, Lidarr, …) are mocked with `vi.mock()`. Route imports come after all `vi.mock()` calls.
- Auth: `setMockSession()` / `clearMockSession()` (`tests/setup/mock-session.ts`). The mock mirrors the real module, including the API-key branch (`rotateSession` throws, `isSessionValid` is true), `authenticatedAt` stamping, and a session object that answers `in`, spreads and `delete` like the real one.
- `cleanDatabase()` (`tests/setup/test-db.ts`) truncates every table in `public` except `_prisma_migrations` (read from `pg_tables`) and drops the cached library listings (`media-list:`). A test that writes rows directly and then lists again must call `invalidateMediaCaches()`, as the app's writers do.
- Constructor mocks use the `function()` keyword, not arrow functions (Vitest 4). Use `vi.hoisted()` for variables referenced inside `vi.mock()` factories.
- Call handlers directly: `callRoute(GET, opts)` / `callRouteWithParams(POST, { id }, opts)`; `expectJson<T>(response, status)` parses and asserts the status.
- Factories (`tests/setup/test-helpers.ts`): `createTestUser`, `createTestServer`, `createTestLibrary`, `createTestMediaItem`, `createTestRuleSet`, `createTestSonarrInstance`, `createTestRadarrInstance`, `createTestLidarrInstance`, `createTestSeerrInstance`, `createTestExternalId`, `createTestLogEntry`, `createTestApiKey` (returns `{ key, row }`).
- Test files are type-checked by `pnpm build` (tsconfig includes `tests/`): a test that runs but fails `tsc` breaks the build.
- Config: sequential (`pool: "forks"`, `fileParallelism: false`), test timeout 15 s, hook timeout 30 s. `vitest.config.ts` points `BACKUP_DIR`, `IMAGE_CACHE_DIR` and `LOG_ARCHIVE_DIR` at a per-run temp dir (CI cannot write the `/config` defaults); `tests/unit/setup/runtime-dirs.test.ts` fails if any is unset or under `/config`. A new env-overridable `/config` path goes in both. A test needing its own directory sets the variable before the module loads.
- **Coverage requirement:** scope is `src/lib/**/*.ts` and `src/app/api/**/*.ts`. Every new or modified file there must have tests: each new route handler under `src/app/api/` gets an integration test in `tests/integration/`, each new `src/lib` module a unit test in `tests/unit/`. A fully covered lib does not make its route covered — bugs hide in the seams (session, validation, rate limiting, DB writes).

### Browser E2E (Playwright)

Real-browser tests in `e2e/*.spec.ts` (Playwright, separate from Vitest). Run with `pnpm e2e:docker` (Postgres + the production image + the Playwright image; browsers pre-baked) or `pnpm build && pnpm e2e:install && pnpm e2e` on the host; CI runs `.github/workflows/e2e.yml` on PRs. Setup, seeding (`e2e/seed.ts`, `dropAppCaches`), dashboard stubbing (`openDashboardInBrowser`), the spec list and the image tag rule are in the **`e2e-tests`** skill.

## Architecture

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript · PostgreSQL 18 · Prisma 7 · Tailwind CSS v4 · shadcn/ui · Docker

- `src/app/(authenticated)/` — protected pages (`layout.tsx` validates the session and redirects): Dashboard (`/`), Settings (`/settings`), Library (`/library/movies`, `/library/series` with `/seasons` and `/episodes`, `/library/music`, `/library/history`), Query, Lifecycle (`/lifecycle/rules`, `/lifecycle/matches`, `/lifecycle/pending`, `/lifecycle/exceptions`), Tools (`/tools/streams`, `/tools/preroll`, `/tools/trash`, `/tools/ai`), System Logs (`/system/logs`).
- `src/app/login/`, `src/app/onboarding/` — public. After sign-in the login page goes to `/` or `/onboarding` by the response's `hasServers` (`userHasServers`, `src/lib/api/has-servers.ts`, returned by `POST /api/auth/local/login` and both `plex/token` branches).
- `src/app/api/` — API routes; all require a session except the auth endpoints. `src/app/api/v1/` is the public API (API key only).
- `src/lib/` — server and shared logic; `src/components/` — UI (`src/components/ui/` is shadcn/ui, never edited directly); `src/hooks/` — React hooks.

### Subsystem skills

Subsystem detail lives in project skills under `.claude/skills/`. **Load the matching skill before changing code in its area** — each one holds the invariants, the file map and the tests that enforce them.

| Area | Skill |
|------|-------|
| Plex / Jellyfin / Emby API specs, media-server clients, container guard, artwork cache | `media-server-api` |
| Sonarr / Radarr / Lidarr API specs, Arr clients, integration HTTP layer and instance routes, TRaSH Guide Sync | `arr-api` |
| Seerr API spec and integration | `seerr-api` |
| Watch history, play-state reconciliation, Tracearr import and API | `watch-history` |
| Full / incremental / requested syncs, SyncJob rows, Graphile Worker jobs and scheduling | `sync-engine` |
| Event bus, SSE, `useRealtime`, fallback polls, media-server WebSockets | `realtime-events` |
| Settings page, detail pages, list loading and caching, shell settings, shared components and hooks | `frontend` |
| Dashboard server render, zones, stats, custom cards | `dashboard` |
| Sessions, step-up / reauth, SSO, rate limiting, security headers | `auth-security` |
| Public API (`/api/v1`), API keys, OpenAPI document | `public-api` |
| Listing routes: pagination detail, SQL aggregates, server presence, listing cache, filter internals | `library-listings` |
| Condition/rule engine, Query criterion columns | `rule-engine` |
| Lifecycle detection, scheduling, deletion ceiling, execution, Plex collections | `lifecycle` |
| Backup & restore | `backup-restore` |
| AI Analysis | `ai-analysis` |
| Playwright e2e suite | `e2e-tests` |
| Docs site, which doc page covers what | `doc-feature` |
| Scaffolding: routes, tests, schemas, migrations, features | `api-route`, `api-test`, `zod-schema`, `prisma-migration`, `scaffold-feature` |
| Running the app, screenshots | `run-librariarr` |

**Keep skills current**: a change to behaviour, a default, a file path or an invariant a skill describes updates that skill in the same change. Skills hold rules and pointers; rationale and incident history go in code comments and commit messages.

### Core libraries

- `src/lib/db.ts` — Prisma singleton. Import `@/lib/db`, NOT `@/lib/prisma`.
- `src/lib/auth/with-session.ts` — `withSession` (see "Route Session Guard").
- `src/lib/validation.ts` — every Zod schema + `validateRequest`.
- `src/lib/api/sanitize.ts` — `sanitize()`, `sanitizeErrorDetail()`.
- `src/lib/api/json-response.ts` — `jsonResponse(request, body, init?)`: `NextResponse.json` with gzip (**Next.js 16 does not compress Route Handler responses**). Use it for any route that can return more than a few KB. Bodies under 4 KB or requests without `Accept-Encoding: gzip` get plain JSON (integration tests read them unchanged). Lists over 1,000 rows (up to three levels deep) serialise a slice at a time (`stringifyYielding`, byte-identical to `JSON.stringify`); the flat list routes shape rows with `mapInSlices`. Both yield to the event loop.
- `src/lib/progress/stream.ts` — `progressStreamResponse(run, { request })`, the NDJSON progress protocol (query, query actions, rule preview, AI chat, history sync): gzip with a sync flush per line, the result written through `writeJsonYielding`, the run aborted by the request signal. A new streaming route passes `request`.
- `src/lib/cache/` — `appCache`, `invalidateMediaCaches()` (see "In-Memory Cache").
- `src/lib/integrations/http.ts` — `createIntegrationHttp` (see "Integrations" below).
- `src/lib/url-normalize.ts` — `stripTrailingSlashes(url)`, the one trailing-slash rule.
- `src/lib/concurrency.ts` — `mapWithConcurrency` (pool, fails fast), `settleWithConcurrency` (never stops).
- `src/lib/logger.ts` — `logger` (backend), `apiLogger` (API), `dbLogger` (database); console + `LogEntry` table; debug needs `LOG_DEBUG=true`. `GET /api/system/logs?count=false` skips the total (the page's 5 s refresh counts every 6th tick, `COUNT_EVERY_TICKS`); `/api/system/logs/sources` uses a recursive-CTE loose index scan.
- `src/lib/theme/accent-colors.ts` — accent presets (OKLCH).
- `src/lib/format.ts`, `src/lib/media/display-title.ts`, `src/lib/media/quality-chips.ts`, `src/lib/media/hover-data.ts`, `src/lib/media/stream-decision.ts` — the one place for dates, titles, quality chips, hover data and transcode decisions (see the `frontend` skill).

## Critical Conventions

### Single-user model

Librariarr runs with exactly one admin account:

- **Schema**: `AppSettings.userId @unique` — the DB rejects a second admin row.
- **Setup gate**: `src/app/api/auth/setup/route.ts` and `src/app/api/auth/plex/token/route.ts` reject creating a second user.
- **Check-setup**: `src/app/api/auth/check-setup/route.ts` uses `findFirst()` because there is one and only one admin.

Code references `session.userId` because per-user resources (`MediaServer`, `RuleSet`, `LifecycleAction`, …) carry a `userId` FK — a normal relation, not a sign that more than one user can exist. **Never** add per-user cache keys, multi-tenant invalidation patterns, "no cross-tenant leak" tests or "tenant isolation" comments.

### Route Session Guard

Every signed-in route handler is wrapped in `withSession` (`src/lib/auth/with-session.ts`), which answers 401 `{ error: "Unauthorized" }` itself and hands the handler a `LoggedInSession` whose `userId` is a string:

```typescript
import { withSession } from "@/lib/auth/with-session";

export const GET = withSession(async (session, request: NextRequest) => {
  const items = await prisma.ruleSet.findMany({ where: { userId: session.userId } });
  return NextResponse.json({ items });
});

// Dynamic segments: the route context follows the request (params is a Promise in Next.js 16).
export const DELETE = withSession(async (session, request: NextRequest, { params }: { params: Promise<{ id: string }> }) => { … });
```

- It reads `getSession()`, so revocation, the settings bundle's `withSharedSession` and `withApiKey`'s principal all apply.
- Declare only the parameters the handler reads: a handler of `(session)` alone is callable with no arguments (the settings bundle relies on that).
- Do not write an inline `getSession()` + `isLoggedIn` check in a new route. Inline checks are only for the sign-in flows and where something must run first (a rate limit — `ai/chat`, `settings/ai/test`; the same-origin check — the SSO routes; the bundle's path validation).

### API Request Validation

All mutation routes validate through `src/lib/validation.ts`:

```typescript
import { validateRequest, someSchema } from "@/lib/validation";
const { data, error } = await validateRequest(request, someSchema);
if (error) return error;
```

- All Zod schemas live in `src/lib/validation.ts` (never inline in a route), imported from `zod/v4`.
- Validation failure → 400 `{ error: "Validation failed", details: [...] }`; malformed JSON → 400 `{ error: "Invalid JSON in request body" }`.
- `validateOptionalRequest` for an optional body (`POST /api/servers/[id]/sync`): no body validates as `{}`, a present body must parse and match.

### API Response Security

- Routes returning server/integration records wrap them in `sanitize()` (`src/lib/api/sanitize.ts`), which recursively masks `accessToken`, `apiKey`, `plexToken`, `passwordHash`, `backupEncryptionPassword`, `oidcClientSecret`, `aiApiKey` with `"••••••••"` (`MASKED_VALUE`).
  ```typescript
  return NextResponse.json({ server: sanitize(server) });
  ```
- Error text — including a failed connection's — goes through `sanitizeErrorDetail()` (strips internal paths, private IPs and `*.plex.direct` hostnames).
- **A settings route returns only the fields its tab reads, never a whole `AppSettings` row** (it holds the backup passphrase, OIDC secret, AI key and Discord webhook, which `sanitize()` does not mask by name there). Always `select` on `appSettings` reads that reach a response (`tests/integration/settings/settings.test.ts`).
- Integration edit flows test through server-side `[id]/test-connection` (POST `/api/integrations/{type}/{id}/test-connection`), never by sending stored keys to the browser. The `[id]` PUT tests the connection only when the URL (trailing slashes aside) or the key actually changes, and the forms require a passing test only then (`changesConnection`). Arr/Seerr forms send `externalUrl` only when it changed; add/edit errors show the first validation `details` entry via `integrationSaveError`.
- Auth endpoints are rate-limited (see the `auth-security` skill) and answer 429 with `Retry-After`.
- Media queries verify ownership: `findFirst` with `library: { mediaServer: { userId: session.userId } }`, never a bare `findUnique({ where: { id } })`.

### Authentication and step-up (essentials — detail in the `auth-security` skill)

- The session cookie carries identity only, never a credential; the Plex token is read from the `User` row via `getStoredPlexToken`. `getSession()` enforces revocation (`sessionVersion`).
- **Every login path establishes its session through `rotateSession()`**, never `getSession()`.
- Under an API key the cookie is never read; `getSession()` returns the key owner's frozen session.
- **Actions that add a lasting way in, or expose a credential, need a recent sign-in** (`hasRecentLogin`, refused via `reauthRequired`): API key creation, a first password, Plex/SSO linking, backup create/download/restore, adding a Plex server by machine id (the token is looked up server-side), a server URL change or turning `tlsSkipVerify` on while its token stays, sending a stored key to a new URL (`refuseStoredKeyToNewUrl`), changing SSO's identity source (turning SSO on, `ssoMode`, `forwardAuthUserHeader`, the issuer while OIDC SSO is on), changing the forward-auth email or name header (copied into the account, which a session reads back; no forward-auth header may name a credential header), and turning password or Plex sign-in back on. The full list is in the `auth-security` skill. **Keep this list closed**: a new route that adds a sign-in method or long-lived credential, or returns or forwards a stored Plex token, must call it, and a route relaying a media server's responses must restrict what it asks for.
- **Every client call to a recent-login-guarded route goes through `fetchWithReauth`** (`src/lib/auth/reauth-client.ts`); `tests/unit/auth/reauth-callers.test.ts` enforces it.
- Credential-verifying routes are rate-limited and charged only on failure (`peekAuthRateLimit` + `reserveAuthAttempt`); `src/proxy.ts` applies the CSRF origin check to every non-GET/HEAD/OPTIONS `/api/*` request.

### Public API (essentials — detail in the `public-api` skill)

- `/api/v1` accepts only API keys, and keys work nowhere else. Each file is `withApiKey(scope, handler)` over the internal route's handler; GET needs a read scope, every other method a write scope.
- **Every new v1 route needs** an `API_OPERATIONS` entry (`src/lib/api-keys/openapi.ts`), a row in `tests/integration/api-v1/routes.test.ts`, a row in `docs/src/content/docs/docs/advanced/api.mdx`, and an update to the pinned table in `tests/unit/api-keys/v1-routes.test.ts`. Never wrap a handler that reads the stored Plex token, writes the session, streams, manages credentials, or runs heavy work inline.
- Every write input a v1 route reaches is bounded with `.max()`; a value placed in a media-server or Arr URL path is one encoded segment. A key can never delete in bulk (fixed limits in `src/lib/api-keys/limits.ts`).

### API Pagination

- Params: `page` (1-based, default 1), `limit` (default 50, capped at 100–200; `0` = all), `offset`, `sortBy`, `sortOrder`, parsed by `parseListPagination` (`src/lib/api/pagination.ts`).
- **Every pageable list route orders by a total order** — append `{ id: "asc" }` after the user's sort.
- N+1 trick: fetch `limit + 1`; if over, pop and set `hasMore: true`. Response: `{ items: [...], pagination: { page, limit, hasMore } }`.
- `startsWith` for server-side alphabet filtering (A–Z, or `#` for non-alpha). List payloads exclude `summary` (list state is typed `MediaListItem`).
- The series/season and artist/album listings aggregate in SQL; see the `library-listings` skill.

### Multi-Server Dedup

- `resolveServerFilter(userId, serverId, libraryType)` (`src/lib/dedup/server-filter.ts`) is the **required first step** of every media query route: `{ serverIds, isSingleServer, preferredTitleServerId, … }`. When `isSingleServer` is false, add `where.dedupCanonical = true`.
- `dedupKey` is a normalized hash of item metadata; `dedupCanonical = true` marks the preferred copy (`recomputeCanonical`, `src/lib/dedup/recompute-canonical.ts`). Server presence helpers: `getServerPresenceByDedupKey`, `getServerPresenceByGroup`.

### Series identity

Episodes are stored, not shows, so a show is derived — and it is keyed on **`MediaItem.seriesKey`**, never on `parentTitle` (same-titled different shows — The Office UK vs US — would merge, blending the aggregates destructive rules read and letting a `DELETE_SONARR` resolve the wrong series).

- **The key** (`src/lib/media/series-key.ts`, the one shared helper): `computeSeriesKey` returns `tvdb:<id>` → else `tmdb:<id>` → else `title:<lower(trim(parentTitle))>`, from the **series-level** external ids every episode stores (the sync resolves show-level Guids via `grandparentRatingKey`). `resolveSeriesKey(row)` prefers the stored column and recomputes only for a row that predates it. `seriesKeySqlExpression()` is the SQL twin (backfill, migration 0015). Keep the three in lockstep (`tests/integration/media/series-key-backfill.test.ts`).
- Not `grandparentRatingKey`: it is per server, so the same show on two servers would split. `seriesKey` merges the same show across servers (shared TVDB id) and separates same-titled shows.
- **Written by the sync**: `buildRowParams` in `sync-server.ts` (SERIES rows; others NULL) and the incremental sync; legacy rows are backfilled by `backfillSeriesKeys` in `runBackfillIfNeeded` at startup.
- **Read everywhere series group**: `series/grouped`, `seasons`, `series`, `all-seasons`, `watch-history` (accept `seriesKey`, legacy `parentTitle` fallback), `group-summary`, `search`; the query engine's grouped SQL and its actions route; both rule engines; the stats layer (`library-stats.ts`, `breakdown.ts`, `watch-analytics.ts`); `lifecycle/exception-guard.ts` (`protectionKey`); the Exceptions page grouping. Anything counting or ranking distinct shows keys on `seriesKey`. Series detail responses return `seriesKey` for use as the React key and for the detail routes.
- The rule engines group **per library** (`libraryId::seriesKey`, in `evaluateSeriesScope`/`groupSeriesResults`/`aggregateEpisodesIntoSeries`) so a show on two servers stays two aggregates, which `detect-matches` collapses by Arr id. The library listings merge across servers by pure `seriesKey`.

### Artist identity

Tracks carry the artist as `parentTitle` and every track stores its ARTIST's MusicBrainz id as `MUSICBRAINZ`; there is no artist-identity column. Compare artist titles with `normalizeArtistTitle` (`src/lib/media/artist-key.ts`). Grouping and the whole-artist exception guard are in the `lifecycle` skill.

### Naming series and episodes

An episode row's `title` is the episode's name; the show is `parentTitle`. Name TV items through `src/lib/media/display-title.ts`: a show → `seriesTitleOf`; one episode → `formatEpisodeTitle` (`"<Show> SxxExx"`) or `formatMediaItemTitle` for any type; `formatEpisodeCode` is the bare `S01E02`; a playback session → `formatSessionMediaTitle` (`src/lib/media-server/session-title.ts`, from `grandparentTitle`, never `parentTitle`). Lifecycle actions are named with `actionTargetTitle` (`lifecycle` skill). Use the episode's own title only where the show is already on screen.

### Play state and watch history (detail in the `watch-history` skill)

- **`MediaItem.playCount` and `lastPlayedAt` only ever move forward**: every writer uses `GREATEST`/`Math.max`, never `= EXCLUDED`. DELETE rules read these columns.
- A `WatchHistory` row is one play event. **"Counts as a play" has one definition**, `src/lib/media/watch-completion.ts` (`completedPlaySql` / `COMPLETED_PLAY_FILTER`, admitting the NULL a native row carries). Every consumer feeding play counts, `watchedByUser` rules or Seerr watch correlation must use it; a new consumer decides explicitly.
- Every path that destroys watch history in bulk must withdraw the server's watch-history evidence (`src/lib/media/watch-evidence.ts`), and every withdrawal needs a writer that can restore it.

### Events and polling (detail in the `realtime-events` skill)

- **Events carry no figures** — only `meta.serverId` or a scope; the receiver refetches the route that owns the number.
- **Every `AppEventType` must have at least one `useRealtime` subscriber** (`tests/unit/events/event-subscriber-coverage.test.ts`), or a `SERVER_ONLY` entry with a reason.
- Polls are fallbacks: run them through `useFallbackPoll`, never delete one. **Do not remove `AuthenticatedShell`'s `useRealtime` call** — it keeps the shared `EventSource` open across navigations.

### Integrations (detail in `arr-api`, `seerr-api`, `watch-history`, `media-server-api`)

- **Every integration client gets its axios instance from `createIntegrationHttp`** (`src/lib/integrations/http.ts`), which registers `configureRetry` before the `IntegrationError` converter (axios runs interceptors in order). Writes are retried only when the failure provably preceded sending. `NO_RETRY` for interactive tests and probes. Media-server clients use `instrumentMediaServerClient`.
- Integration routes are one-line builders over `src/lib/integrations/instance-routes.ts`. Stored keys never go to the browser — edit flows test through `[id]/test-connection`.
- Bound every call to a possibly-dead instance (`withTimeout`, `UnreachableInstances`); a write's timeout is never a host-level failure.

### Lifecycle safety (detail in the `lifecycle` and `rule-engine` skills)

- A rule set whose criteria depend on an external source that cannot answer (no enabled Arr/Seerr instance, un-established play history) is **skipped, never evaluated as empty** — `src/lib/lifecycle/evaluability.ts` is the single policy point, and every call site passes the Arr instance and servers it evaluates against (the rule set's, the editor's unsaved values, the tested item's server, or the query's servers).
- A rule set judging whole shows or artists (series/artist scope on) may not use a criterion that describes one episode or track — `groupScopeViolation` (`src/lib/conditions/group-scope.ts`) is the one predicate: saving refuses it, detection skips it, `actionHoldOf` (`src/lib/lifecycle/held-actions.ts`) holds its actions on every execution path, and the editor gates on it. A new condition field must be classified in `tests/unit/conditions/group-scope.test.ts`.
- An exception protects every copy of an item (same `dedupKey`), and a whole-record delete is cancelled when any item of its group is excepted.
- The lifecycle and query engines share one implementation of both evaluation phases — fix operator/NULL semantics once, in the shared functions. A shared evaluator returning `null` (unknown operator) must match nothing without applying `negate`.
- Never sync a Plex collection per rule set — membership is the union of every contributing rule set.

### Cross-bundle singletons

In a production build the job worker and the realtime manager (started from `instrumentation.ts`) load their own copy of every module, and the route handlers another. **Any in-process state both sides read or write — a bus, registry, cache, lock — must be pinned to `globalThis` unconditionally** (`globalForX.x ??= new X()`), never with the dev-only HMR idiom (`if (process.env.NODE_ENV !== "production") global… = …`), which is one object in dev and tests and two in production.

- `tests/unit/events/cross-bundle-state.test.ts` walks the import graph from `instrumentation.ts` and every route/page/layout and lists the module-level state of each module both load; each must be pinned or listed in its `ALLOWED` map with a reason.
- `tests/unit/events/no-dev-only-global-pin.test.ts` refuses the dev-only pattern under `src/` (only `src/lib/db.ts` is allowed).
- `tests/unit/events/process-singletons.test.ts` loads each shared registry twice under `NODE_ENV=production` — add new ones there. `e2e/realtime-push.spec.ts` runs the real production build.
- State only one side touches (e.g. the rate limiters) needs no pin. Pinning can change behaviour: the shared media-server circuit breaker (`health-cache.ts`) is why `testConnection` sends `BYPASS_BREAKER` + `NO_RETRY` (`tests/unit/media-server/connection-test-breaker.test.ts`) and `fetchImage` sends `NO_BREAKER_MARK`.

### In-Memory Cache

`appCache` (`src/lib/cache/memory-cache.ts`) — in-process (no Redis), not persisted, **pinned to `globalThis`** (`tests/unit/cache/memory-cache.test.ts`):

- `get<T>(key)`, `set(key, data, ttlMs?)`, `getOrSet(key, compute, ttlMs?, { shouldCache? })` — single-flight; an `invalidate`/`invalidatePrefix`/`clear` hitting a key mid-compute keeps that result out of the cache. Use `shouldCache(value)` to keep a bad result (a `partial` Seerr walk) out while still answering waiters — never cache-then-`invalidate`.
- `invalidate(key)`, `invalidatePrefix(prefix)`, `clear()`. Default TTL 60 s; bounded (`maxEntries`, expired-then-oldest).
- **Library listing responses** are cached under `media-list:` by `withListResponseCache` (`src/lib/api/cached-list-response.ts`); see the `library-listings` skill.
- **Always call `invalidateMediaCaches()`** (`src/lib/cache/invalidate.ts`) after any mutation that changes media items, server membership, dedup canonical selection, or title/artwork preference — sync, purge, server CRUD, the library enable/disable route (`PUT /api/servers/[id]/libraries`), the dedup/title-preference settings routes. It drops every media-derived prefix: `server-filter:`, `stats:`, `group-summary:`, `cross-tab:`, `custom-stats:`, `timeline:`, `distinct-values` (incl. `distinct-values:genres`), `watch-history-filters:`, `recently-added:`, `image-meta:`, `query-action-live:`, `query-distinct-values`, `media-list:` (`tests/unit/cache/invalidate.test.ts`). Never hand-roll partial invalidation. Rule set create/rename/delete calls `invalidateRuleSetNameCaches()`.

### Filter Utilities

- `src/lib/filters/build-where.ts` — `applyCommonFilters(where, params, genreSpellings?, resolutionSpellings?, opts?)` mutates a `Prisma.MediaItemWhereInput` from the standard params. Multi-select values are pipe-separated (`?resolution=4K|1080P`); condition filters are `op:value` pairs with logic (`?yearConditions=gte:2020|lte:2024&yearLogic=and`). `applyStartsWithFilter` handles `#` and A–Z.
- **Every user-supplied value that lands in a LIKE-shaped comparison goes through `escapeLike`** (`src/lib/filters/escape-like.ts`) — Prisma `contains`/`startsWith`/insensitive `equals` and raw `ILIKE` all treat `%`/`_` as wildcards. Escape at the site of use, never in a parser.
- Pass the genre and resolution spellings (`loadGenreSpellings`, `loadResolutionSpellings`) — genre matching is case-insensitive. Detail in the `library-listings` skill.

### Prisma and Database

- Import as `import { prisma } from "@/lib/db"`. The client is generated to `src/generated/prisma` (types: `@/generated/prisma/client`).
- `fileSize` is `BigInt`: serialize to string in API responses, convert back on the frontend.
- Production runs `prisma migrate deploy` then `prisma db push` (the entrypoint always runs both). Schema changes need a migration file for production (`prisma-migration` skill); dev uses `db push`.
- **A new Prisma model must be placed in `BACKUP_TABLE_ORDER` or `BACKUP_EXCLUDED_TABLES`** (`src/lib/backup/backup-service.ts`; `tests/unit/backup/table-order.test.ts`) — see the `backup-restore` skill.
- **Mind Postgres' JIT on new raw aggregates**: any statement whose estimated cost passes `jit_above_cost` (100,000) pays ~600 ms of compilation. Correlated per-row subqueries cross it easily (`EXPLAIN ANALYZE` shows a `JIT:` section). Prefer a join or a batched `id = ANY($1)` lookup.
- **A list as long as a library never goes into one `in` list** (32,767 bind parameters per statement. Prisma 7 splits one over-long `in` into several statements for a `findMany` without `orderBy`/`take`/`skip` — beside a relation filter or a short second list too — and for `updateMany`/`deleteMany`; it refuses with P2029 when that `findMany` has `orderBy`, `take` or `skip`, for `count`/`groupBy`/`aggregate`, and when two long lists share one query). Send ONE array parameter in raw SQL (`= ANY($1::text[])`) or slice through `inChunks`/`findInChunks` (`src/lib/conditions/in-chunks.ts`, `IN_CHUNK_SIZE` 10,000), inside one transaction when it must be all-or-nothing (`tests/integration/lifecycle/large-id-lists.test.ts`).
- **Indexes earn their place with an `EXPLAIN ANALYZE`**, recorded in the migration (see `0030_query_indexes`). An index no plan picks still costs every write.
- **Some indexes exist only in migration SQL** (`0030`): the expression index `MediaItem(type, LOWER(TRIM("parentTitle")))` and partial GIN trigram indexes on `title`/`parentTitle`/`albumTitle` (created in a guarded `DO` block that skips them with a NOTICE when `pg_trgm` is unavailable). The entrypoint's `db push` leaves expression/partial indexes alone (a plain undeclared index would be dropped; Prisma's `partialIndexes` preview would drop them unless declared). Databases built by `db push` alone (dev, test, e2e) lack them, so a plan measured there is not the production plan.

### Styling

- Tailwind CSS v4 with the **OKLCH** colour model (not HSL); CSS variables in `src/app/globals.css`. Dark mode is hardcoded (`className="dark"` on `<html>`). shadcn/ui "new-york".
- **Fonts**: Sora (`font-display`), Plus Jakarta Sans (`font-sans`), JetBrains Mono (`font-mono`), self-hosted from `@fontsource-variable/*` (imported in `layout.tsx`, families in globals.css `@theme`). Never `next/font/google` (it downloads during `next build`).
- Every page `<h1>`: `text-2xl sm:text-3xl font-bold font-display tracking-tight` (use `PageHeader`).
- Accent colours override `--primary`, `--primary-foreground`, `--ring`, `--sidebar-primary`. Preset names are persisted in `AppSettings.accentColor` — never rename them.
- **Mobile / PWA**: installable (`src/app/manifest.ts`, theme colour `#0c0d10`, `viewport-fit=cover`). Below `md` (768px) the shell shows a glass header whose hamburger opens the drawer. Safe-area utilities: `.pt-safe`, `.pb-safe`, `.px-safe`/`.pl-safe` (app frame and full-screen panel use `.px-safe`, the drawer `.pl-safe`). Size frames and caps in `dvh`, never `vh` (`h-dvh`, `max-h-[85dvh]`; `tests/unit/app/viewport-units.test.ts` refuses `h-screen` and `max-h-[…vh]`). Every page must fit 320px: toolbars `flex-wrap`, card headers with actions stack below `sm`, tab strips scroll in their own `max-w-full overflow-x-auto` box (style guide "Phone Widths").
- **Full style guide:** `docs/src/content/docs/docs/development/style-guide.mdx` — consult when making UI changes.

### Data Patterns

- TV episodes are individual `MediaItem` rows with `parentTitle` (series name), `seasonNumber`, `episodeNumber`; series identity is `seriesKey` (above).
- `LibraryType`: `MOVIE`, `SERIES`, `MUSIC`.
- External IDs (TMDB, TVDB, IMDB, MUSICBRAINZ, MBID) live in `MediaItemExternalId` — Arr correlation: movies via TMDB → Radarr, series via TVDB → Sonarr, music via the artist's MusicBrainz id → Lidarr.
- `WatchHistory` rows are play events — see the `watch-history` skill.
- Dynamic range normalizes to "Dolby Vision", "HDR10+", "HDR10", "HLG" or "SDR"; audio profile to "Dolby Atmos", "Dolby TrueHD", "DTS-HD MA", "DTS:X", etc.
- Calendar-day fields (`originallyAvailableAt`, `arrReleaseDate`, `arrInCinemasDate`, `arrFirstAired`, `lastEpisodeAiredAt`) are stored as UTC midnight, carry `dateOnly: true` (`DATE_ONLY_FIELDS` in `fields.ts`) and are displayed with `formatDateOnly`; instants use `formatDate`. A new calendar-day field must set the flag.

### Notifications

- `src/lib/discord/client.ts` — Discord webhooks for lifecycle events (action success/failure, match count changes, held deletions), maintenance mode changes, and API keys created or deleted (`buildApiKeyEmbed`, gated by `discordNotifyApiKeys`). A 429 is retried once when Discord asks for ≤ 5 s; an undelivered notification is logged at WARN without the webhook URL.
- Notification failures never block lifecycle processing (wrapped in try/catch).

### Next.js Config

- `output: "standalone"` (Docker). Path alias `@/*` → `./src/*`. `experimental.optimizePackageImports: ["radix-ui"]` (compare two builds before relying on it or removing it).
- Security headers live in `next.config.ts` `headers()`; the page CSP (with a per-request nonce) is sent by `src/proxy.ts` (see the `auth-security` skill).
- **Dependency floors**: `pnpm-workspace.yaml` `overrides` force `sharp` ≥ 0.35.4 and `js-yaml` ≥ 4.3.2. After changing overrides, delete `node_modules/.pnpm-workspace-state-v1.json` (pnpm caches workspace settings). The runtime image installs the Prisma CLI at the exact version the lockfile resolved (`/prisma-version` from the `deps` stage).

### Documentation Maintenance

When adding features or changing behaviour, **update the documentation in `docs/src/content/docs/docs/` in the same PR** — the `doc-feature` skill maps each area to its page. In particular: changed defaults, env vars or config options → `getting-started/configuration.mdx` and `getting-started/installation.mdx`; rule engine changes → `features/lifecycle-rules.mdx` (field lists, operators, action types and units must match the code). When architecture, conventions or file paths described here or in a skill change, update this file or that skill too.

### CI/CD

- `.github/workflows/ci.yml` — lint, test, build on pushes to main and PRs.
- `.github/workflows/release-please.yml` — on push to main runs release-please; a created release builds and pushes the Docker image with `latest` + semver tags.
- `.github/workflows/docker-nightly.yml` — on push to `main` (or manual dispatch) pushes the rolling `nightly` tag and immutable `nightly-<sha>` tags; never `latest`/semver.
- `.github/workflows/docker-publish.yml` — manual Docker Hub publish.
- `.github/workflows/e2e.yml` — Playwright compose stack on PRs.
- `.github/workflows/docs-deploy.yml` — docs site.
- `.github/workflows/pr-title-lint.yml` — validates every PR **title** against Conventional Commits (see below).

### Git Conventions

- Husky pre-commit runs `pnpm exec eslint --quiet`; commit-msg enforces [Conventional Commits](https://www.conventionalcommits.org/) via commitlint (`@commitlint/config-conventional`).
- Format: `type(scope): description` — e.g. `feat: add stream manager`, `fix(auth): handle expired tokens`.
- **Every PR title MUST be a Conventional Commit from the moment the PR is opened**, whoever creates it: `type(scope): description` or `type: description`, `type` one of `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`; description starts lowercase, no trailing period. Good: `fix(auth): confirm identity in place instead of requiring sign-out`. Bad: `Add in-place re-authentication for sensitive actions`. Model it on the branch's own commit subjects. When updating a PR, check its title too.
- Squash-merging makes the PR title the commit subject on `main`, which release-please reads for the version bump and changelog — a non-conventional title drops the PR from the release. `pr-title-lint.yml` enforces it.
