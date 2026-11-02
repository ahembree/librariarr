---
name: media-server-api
description: Plex, Jellyfin and Emby — where to fetch each server's REST API spec and how Librariarr's media-server clients work (PlexClient, the shared Jellyfin/Emby client, interceptors, container guard, artwork cache). Use when adding, debugging or extending a media-server API call, a client method, or artwork fetching.
---

# Media-server APIs (Plex, Jellyfin, Emby)

Realtime WebSocket handling lives in the `realtime-events` skill; how syncs use these clients is in `sync-engine`.

## API references

Never load a spec whole into context — extract what you need with `jq` (JSON) or `yq` (mikefarah v4, YAML).

| Server | Spec | Format | Auth |
|--------|------|--------|------|
| Plex | `https://raw.githubusercontent.com/LukeHagar/plex-api-spec/main/plex-api-spec.yaml` (community OpenAPI 3.1 behind the official SDKs; the official spec at https://developer.plex.tv/ is only a browser `blob:` download — use it to verify if the mirror looks stale) | YAML | `X-Plex-Token` header (scheme `token`); identifying client headers (`X-Plex-Client-Identifier`, `X-Plex-Product`, …) are in `components.parameters` |
| Jellyfin | `https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json` (~2 MB) | JSON | several schemes — read `components.securitySchemes` |
| Emby | `https://swagger.emby.media/openapi.json` (~2 MB) | JSON | several schemes — read `components.securitySchemes` and per-operation `security` |

Jellyfin and Emby paths are not version-prefixed (`/Items`, `/Users/{userId}/Items`, `/System/Info`).

```bash
U=https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json   # or the Emby URL
curl -s $U | jq '.paths | keys'                                    # list paths
curl -s $U | jq '.paths."/Items"'                                  # one endpoint
curl -s $U | jq '.components.schemas.BaseItemDto'                  # a schema
curl -s $U | jq '[.paths | to_entries[] | select(.value | .. | .tags? // [] | index("Items")) | .key]'  # by tag
curl -s $U | jq '.components.securitySchemes'                      # auth

P=https://raw.githubusercontent.com/LukeHagar/plex-api-spec/main/plex-api-spec.yaml
curl -sL $P | yq '.paths | keys'
curl -sL $P | yq '.paths."/library/collections"'
curl -sL $P | yq '.components.schemas.Metadata'
curl -sL $P | yq '.tags[].name'
curl -sL $P | yq -o json | jq '[.paths | to_entries[] | select(.value | .. | .tags? // [] | index("Library")) | .key]'
curl -sL $P | yq '{security: .components.securitySchemes, headers: (.components.parameters // {} | to_entries | map(select(.value.in == "header")) | from_entries)}'
```

## Librariarr's clients

- `src/lib/plex/` — OAuth flow and API client. `getDetailedWatchHistory` reads `/accounts` strictly and throws on failure; `getAccounts()` stays lenient (per-item panel, excluded-users picker). History pages through `forEachHistoryPage`, which ends on a short page only when the container reports no `totalSize` or it has been reached — never assume the requested page size was honoured.
- `src/lib/media-server/jellyfin-base.ts` — `getDetailedWatchHistory` scopes to `IncludeItemTypes=Movie,Episode,Audio`, walks `USER_HISTORY_CONCURRENCY` (3) users at a time, and **propagates transient per-user failures** (a swallowed one hands the native full replace a partial history); only 401/403/404 skip a user (WARN). `sessionPath` `encodeURIComponent`s the id and refuses `.`/`..`.
- `src/lib/media-server/http-instrumentation.ts` — `instrumentMediaServerClient`, the interceptor chain both clients install: circuit breaker (unless `BYPASS_BREAKER`), timing/debug logging, breaker reset on success, then `configureRetry` last. `normalizeMediaServerUrl` (trailing slashes stripped) is the one base-URL spelling for axios, the breaker key and hand-built URLs.
- `src/lib/media-server/client.ts` — `MediaItemNotFoundError`, `isMediaItemNotFound` (that error or HTTP 404).
- `src/lib/media-server/item-types.ts` — the **non-media container guard** `isMediaItem`/`partitionMediaItems`: collections, box sets and playlists are never stored. It is a deny-list, so an unknown real type keeps syncing. Plex filters server-side (`PlexClient.getLibraryItemsPage` sends `type=1` for movies) so `totalSize` stays consistent with the page. `isItemForLibraryType` makes a library store only its own type (MOVIE→`movie`, SERIES→`episode`, MUSIC→`track`) — needed by the incremental sync, since a new episode makes Plex/Jellyfin emit entries for its season and show too.

## Artwork cache

- `src/lib/image-cache/image-cache.ts`: fetch → `sharp` resize → WebP q80 → `/config/cache/images/<shard>/<sha256>.webp`, keyed by **library id + normalized artwork URL** (`normalizeCacheUrl` strips Plex's trailing timestamp) **+ width** — rating keys are per server, so the library id is part of the key.
- `src/lib/image-url.ts` (client-safe): widths `CACHE_WIDTH_GRID` 400 (poster/square cards), `CACHE_WIDTH_GRID_WIDE` 640, 800 default, `CACHE_WIDTH_ART` 1920; `parseImageWidth` allow-list (arbitrary `?w=` refused); `resolveArtworkPath` (the one `?type=` fallback chain).
- `invalidateCachedUrls(libraryId, urls)` **must purge every width** (`ALL_CACHE_WIDTHS`) and writes `_stats.json` once per call.
- The media server resizes: `fetchImage(path, { width })` uses Plex's photo transcoder (`/photo/:/transcode?url=…&width=W&height=W&minSize=1&upscale=0`, falling back to the raw path on error, non-image or empty body) or Jellyfin/Emby `maxWidth`, sent with `NO_BREAKER_MARK`.
- `sharp.concurrency(1)`; the cache's own file walks and deletes run `FILE_OP_CONCURRENCY` (8) at a time.

