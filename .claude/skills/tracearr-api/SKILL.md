---
name: tracearr-api
description: Reference for the Tracearr public REST API (self-hosted Plex/Jellyfin/Emby playback monitoring). Use when adding, debugging, or extending Tracearr API calls (watch history, active streams, users, libraries, response schemas).
---

# Tracearr API

Tracearr monitors Plex, Jellyfin and Emby from one instance and exposes a read-only public REST API (plus one stream-termination endpoint).

**Source of truth — the route code in the repo.** Tracearr publishes no separate, anonymously fetchable spec file: the OpenAPI document is served only by a running instance, behind auth (`GET /api/v2/public/docs`, bearer token). So read the route definitions straight from the public source, which needs no auth and is the authoritative schema:

- v2 route + schema definitions (field shapes, response envelopes): `apps/server/src/routes/publicV2.openapi.ts`
- v2 handlers (query params, filters, cursor internals): `apps/server/src/routes/publicV2/{history,media,users,streams,libraries}.ts`
- v1 definitions (legacy — see the media-identifier note): `apps/server/src/routes/public.openapi.ts`

Fetch with the raw prefix `https://raw.githubusercontent.com/connorgallopo/Tracearr/main/` + the path, e.g.

```
curl -sL https://raw.githubusercontent.com/connorgallopo/Tracearr/main/apps/server/src/routes/publicV2.openapi.ts
```

These are TypeScript Fastify route schemas, not a JSON/YAML spec — read them, don't `jq` them. Swap `main` for a release tag to match a specific Tracearr version. If you have a running instance and a token, `GET /api/v2/public/docs` returns the live OpenAPI JSON for exactly that build.

## Auth, paths, limits

- `Authorization: Bearer trr_pub_<base64url>` — the key is generated in Tracearr's Settings → API
- Two live versions: `/api/v1/public/*` and `/api/v2/public/*`. An instance may sit under a base path (`/tracearr/api/v2/...`), so never hardcode the root
- Rate limited per key on a 1-minute window (the max is resolved from Tracearr's DB per request) — handle 429 and back off
- Fastify backend, so failures come back as real HTTP status codes

## Use v2 for anything that joins to a MediaItem

**`/api/v1/public/history` carries no media identifier** — just `mediaTitle` as a string, which is unjoinable without title matching. Reach for v2 instead, whose history records carry `rating_key`, `parent_rating_key`, `grandparent_rating_key`, `media_id`, `imdb_id`, `tmdb_id`, `tvdb_id`, `server_id` and `server_type`, alongside `state`, `percent_complete`, `duration_ms`, `progress_ms`, `is_transcode`, `video_decision` and `audio_decision`.

For this repo: `rating_key` is the join key for `MediaItem.ratingKey` (the map `syncWatchHistory` already builds), and the provider ids line up with `computeSeriesKey`'s `tvdb:` → `tmdb:` precedence as a fallback when a rating key has drifted.

- **Pagination differs by version.** v1 takes `page`/`pageSize`; v2 is keyset — `cursor` is an encoded `{ startedAt, id }` token, with `pageSize` defaulting to 25 and capped at 100
- **v2 history filters server-side:** `user_id`, `server_id`, `media_id`, `rating_key`, `imdb_id`, `tmdb_id`, `tvdb_id`, `media_type` (`movie|episode|track|live|photo|unknown`), `watched`, `since`, `until`
- `since`/`until` are what make incremental sync viable — page from a stored watermark instead of re-pulling the whole history
- v2 also has per-item routes: `/media/{ref}`, `/media/{ref}/children`, `/media/{ref}/stats`, `/media/{ref}/watchers`, `/media/{ref}/history`, plus `/users/{id}/history`, `/recently-added` and `/libraries`
