---
name: tracearr-api
description: Reference for the Tracearr public REST API (self-hosted Plex/Jellyfin/Emby playback monitoring, a Tautulli alternative covering all three server types). Use when adding, debugging, or extending Tracearr API calls (watch history, active streams, users, libraries, response schemas).
---

# Tracearr API

Tracearr monitors Plex, Jellyfin **and** Emby from one instance, so unlike Tautulli (Plex-only) it can serve watch history for every server type. The public API is read-only apart from one stream-termination endpoint.

**Primary source — the OpenAPI spec the instance serves itself.** `GET /api/v2/public/docs` returns raw OpenAPI JSON, but it sits behind auth, so it cannot be fetched anonymously:

```
curl -s -H "Authorization: Bearer $TRACEARR_TOKEN" https://<host>/api/v2/public/docs | jq '.paths | keys'
```

**Fallback with no instance or token** — the route schemas in the repo. These are TypeScript, not a fetchable spec, so read them rather than piping them through `jq`:

- v2 schemas: https://raw.githubusercontent.com/connorgallopo/Tracearr/main/apps/server/src/routes/publicV2.openapi.ts
- v1 schemas: https://raw.githubusercontent.com/connorgallopo/Tracearr/main/apps/server/src/routes/public.openapi.ts
- v2 handlers: `apps/server/src/routes/publicV2/{history,media,users,streams,libraries}.ts` under the same raw prefix

Published docs are at https://docs.tracearr.com/api when reachable from your network.

## Auth, paths, limits

- `Authorization: Bearer trr_pub_<base64url>` — the key is generated in Tracearr's Settings → API
- Two live versions: `/api/v1/public/*` and `/api/v2/public/*`. An instance may sit under a base path (`/tracearr/api/v2/...`), so never hardcode the root
- Rate limited per key on a 1-minute window with the max resolved from Tracearr's DB per request — handle 429 and back off
- Fastify backend, so failures come back as real HTTP status codes (not Tautulli's `result: "error"` inside a 200)

## Use v2 for anything that joins to a MediaItem

**`/api/v1/public/history` carries no media identifier** — just `mediaTitle` as a string, which is unjoinable without title matching. Reach for v2 instead, whose history records carry `rating_key`, `parent_rating_key`, `grandparent_rating_key`, `media_id`, `imdb_id`, `tmdb_id`, `tvdb_id`, `server_id` and `server_type`, alongside `state`, `percent_complete`, `duration_ms`, `progress_ms`, `is_transcode`, `video_decision` and `audio_decision`.

For this repo: `rating_key` is the join key for `MediaItem.ratingKey` (the map `syncWatchHistory` already builds), and the provider ids line up with `computeSeriesKey`'s `tvdb:` → `tmdb:` precedence as a fallback when a rating key has drifted.

- **Pagination differs by version.** v1 takes `page`/`pageSize`; v2 is keyset — `cursor` is an encoded `{ startedAt, id }` token, with `pageSize` defaulting to 25 and capped at 100
- **v2 history filters server-side:** `user_id`, `server_id`, `media_id`, `rating_key`, `imdb_id`, `tmdb_id`, `tvdb_id`, `media_type` (`movie|episode|track|live|photo|unknown`), `watched`, `since`, `until`
- `since`/`until` are what make incremental sync viable — page from a stored watermark instead of re-pulling the whole history
- v2 also has per-item routes: `/media/{ref}`, `/media/{ref}/children`, `/media/{ref}/stats`, `/media/{ref}/watchers`, `/media/{ref}/history`, plus `/users/{id}/history`, `/recently-added` and `/libraries`

## Recipes against the instance spec

Set `T="Authorization: Bearer $TRACEARR_TOKEN"` and `U=https://<host>/api/v2/public/docs`:

- Inspect one endpoint: `curl -s -H "$T" $U | jq '.paths."/api/v2/public/history"'`
- Look up a schema: `curl -s -H "$T" $U | jq '.components.schemas.HistoryRecord'`
- List every query param for a route: `curl -s -H "$T" $U | jq '.paths."/api/v2/public/history".get.parameters[].name'`
