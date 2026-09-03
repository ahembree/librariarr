---
name: tracearr-api
description: Reference for the Tracearr public REST API (self-hosted Plex/Jellyfin/Emby playback monitoring). Use when adding, debugging, or extending Tracearr API calls (watch history, active streams, users, libraries, response schemas).
---

# Tracearr API

Tracearr monitors Plex, Jellyfin and Emby from one instance and exposes a read-only public REST API (plus one stream-termination endpoint).

**Source of truth — the OpenAPI spec, published as a GitHub release asset.** Every stable Tracearr release attaches `openapi-v1.json` and `openapi-v2.json`, and `releases/latest/download` always tracks the newest stable release. These are real OpenAPI 3.0 JSON — the exact files docs.tracearr.com renders — and are fetchable with no auth and queryable with `jq`:

- v2: `https://github.com/connorgallopo/tracearr/releases/latest/download/openapi-v2.json`
- v1 (legacy — see the media-identifier note): `https://github.com/connorgallopo/tracearr/releases/latest/download/openapi-v1.json`

```
V2=https://github.com/connorgallopo/tracearr/releases/latest/download/openapi-v2.json
curl -sL $V2 | jq '.paths | keys'                                  # list endpoints
curl -sL $V2 | jq '.paths."/api/v2/public/history".get'            # one endpoint (params, responses)
curl -sL $V2 | jq '.components.schemas.HistoryRecord'              # a response schema
curl -sL $V2 | jq '.components.securitySchemes'                    # auth
```

Other sources, in order of usefulness: **docs.tracearr.com/api** is the human-browsable render of these same two assets (browser only — it is not anonymously fetchable). A running instance serves its own build's spec at **`GET /api/v2/public/docs`** (bearer token required) — use it to match the exact version you run. The route source (`apps/server/src/routes/publicV2/*.ts` + `publicV2.openapi.ts` in `connorgallopo/Tracearr`) is the last resort, for implementation detail the spec doesn't capture.

## Auth, paths, limits

- `Authorization: Bearer trr_pub_<token>` — the key is generated in Tracearr's **Settings > General**
- Two live versions: `/api/v1/public/*` and `/api/v2/public/*`. An instance may sit under a base path (`/tracearr/api/v2/...`), so never hardcode the root
- Rate limited per key on a 1-minute window — handle 429 and back off
- Fastify backend, so failures come back as real HTTP status codes

## Use v2 for anything that joins to a MediaItem

**v1's `SessionHistory` carries no media identifier** — only `mediaTitle`/`showTitle` strings plus `serverId`/`serverName`, unjoinable to a library item without title matching. v2's `HistoryRecord` carries `rating_key`, `parent_rating_key`, `grandparent_rating_key`, `media_id`, `show_media_id`, `imdb_id`, `tmdb_id`, `tvdb_id`, `library_id`, `server_id` and `server_type`, alongside `state`, `percent_complete`, `progress_ms`/`duration_ms`, `is_transcode`, `video_decision` and `audio_decision`.

For this repo: `rating_key` is the join key for `MediaItem.ratingKey` (the map `syncWatchHistory` already builds), and the provider ids line up with `computeSeriesKey`'s `tvdb:` → `tmdb:` precedence as a fallback when a rating key has drifted.

- **Pagination differs by version.** v1 takes `page`/`pageSize`; v2 is keyset — `cursor` encodes `{ startedAt, id }`, `pageSize` defaults to 25 and caps at 100 (schemas `HistoryResponse` + `CursorMeta`)
- **v2 `/history` filters server-side:** `user_id`, `server_id`, `media_id`, `rating_key`, `imdb_id`, `tmdb_id`, `tvdb_id`, `media_type` (`movie|episode|track|live|photo|unknown`), `watched`, `since`, `until`
- `since`/`until` are what make incremental sync viable — page from a stored watermark instead of re-pulling the whole history
- **Other v2 routes:** `/media/{ref}`, `/media/{ref}/children`, `/media/{ref}/stats`, `/media/{ref}/watchers`, `/media/{ref}/history`, `/users/{id}`, `/users/{id}/history`, `/users/{id}/stats`, `/recently-added`, `/libraries`, `/streams`
