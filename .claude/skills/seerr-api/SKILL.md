---
name: seerr-api
description: Seerr (Overseerr/Jellyseerr) — where to fetch the REST API spec and how Librariarr's Seerr integration works (request walks, the Seerr data map, request stats, links). Use when adding, debugging or extending a Seerr API call or anything that reads Seerr requests.
---

# Seerr

## API reference

Spec (YAML): `https://raw.githubusercontent.com/seerr-team/seerr/refs/heads/main/seerr-api.yml`

Seerr merges Overseerr and Jellyseerr; the API surface has Overseerr's shape. Auth (`components.securitySchemes`): `apiKey` — `X-Api-Key: <apiKey>` header — or `cookieAuth` via `/auth/plex` / `/auth/local`. Query with `yq` (mikefarah v4) or pipe `yq -o json` into `jq`:

```bash
U=https://raw.githubusercontent.com/seerr-team/seerr/refs/heads/main/seerr-api.yml
curl -sL $U | yq '.paths | keys'
curl -sL $U | yq '.paths."/request"'
curl -sL $U | yq '.components.schemas.MediaRequest'
curl -sL $U | yq -o json | jq '[.paths | to_entries[] | select(.value | .. | .tags? // [] | index("request")) | .key]'
curl -sL $U | yq '.components.securitySchemes'
```

The client is built on `createIntegrationHttp` and its routes on `instance-routes.ts` — see the `arr-api` skill.

## Librariarr's Seerr integration

- `src/lib/seerr/` — Seerr (Overseerr/Jellyseerr). `seerr-client.ts`: axios client, `SeerrRequestStatus` (1–5), media status 1–7 (6 BLOCKLISTED, 7 DELETED), `seerrRequesterKey` (plexUsername → username → email; the one requester identity for rules, editor, stats and drill-down), `seerrMediaUsername` (plexUsername → jellyfinUsername, for watch correlation).
  - **Every walk of `GET /api/v1/request` goes through `walkSeerrRequests` (`request-walk.ts`)**: pages of `SEERR_REQUEST_PAGE_SIZE` (500) overlapping by 10 and deduped by id. It **throws rather than returning a partial walk** (a request never read makes media look never requested — fails open) on a page sharing no id with the previous one, a non-advancing cursor, a malformed page or the page cap. A short page ends the walk only when `pageInfo.results` agrees; the walk advances by the rows actually returned. Interactive callers (dashboard card, drill-down, query, `seerr-info`) pass `failFast` (first page `NO_RETRY`; a failed walk is never cached) and walk instances in parallel; `seerr-info` also passes an `AbortSignal`. `mediaType` is sent where accepted (older servers answer 400 → retried without) and re-checked client-side.
  - `seerr-data-map.ts` (`SeerrDataMapBuilder`) is the ONE fold into `SeerrDataMap`: approval = status 2, 4 or 5; dates are the most recent request/approval/decline; TV is one record per TMDB id with a `TVDB:` alias. Lifecycle (`fetchSeerrMetadataByType(userId, types)`, one walk per instance for every type; `fetchSeerrMetadata` is its one-type form) and query (`fetchSeerrDataForQuery`) both merge **every enabled instance**; the query fetcher throws with none enabled, `POST /api/query/actions` checks `hasEnabledSeerrInstances`, and a saved query's `seerrInstanceId` is ignored.
  - `SeerrInstance.externalUrl` (http(s) only via `externalLinkUrlSchema`) is the browser link base, falling back to `url`; API calls use `url`. Links are keyed by TMDB id.
  - `request-stats.ts` + `library-match.ts` back the dashboard card and `/api/seerr/users/[userKey]/requests` (TV matched by TVDB or TMDB and grouped by `seriesKey`; watches correlated through every canonical edition sharing a TMDB id). An instance whose walk fails marks the result `partial` and it is not cached (`shouldCache`). Caches: one key for the card, `seerr-user-requests:<userKey>` for the drill-down; `invalidateSeerrCaches()` on Seerr instance writes. `seerr-info` reports `status4k` when every request is 4K and runs its TVDB-only walk for series only.
  - The manual Execute and force-retry routes refuse (Execute also disarms) a MUSIC rule set with Seerr criteria.
