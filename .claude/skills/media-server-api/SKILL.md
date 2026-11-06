---
name: media-server-api
description: Plex, Jellyfin and Emby — where to fetch each server's REST API spec and how Librariarr's media-server clients work (PlexClient, the shared Jellyfin/Emby client, interceptors, container guard, artwork cache). Use when adding, debugging or extending a media-server API call, a client method, or artwork fetching.
---

# Media-server APIs (Plex, Jellyfin, Emby)

Realtime WebSocket handling lives in the `realtime-events` skill; how syncs use these clients is in `sync-engine`.

## API references

Never load a spec whole into context — extract what you need with `jq` (JSON) or `yq` (mikefarah v4, YAML).

| Server | Spec | Format | Auth (`components.securitySchemes`) |
|--------|------|--------|------|
| Plex (official) | embedded in the Redoc page `https://developer.plex.tv/pms/` — extract it with the command below. Newest (1.2.3 at time of writing), ~200 paths | JSON | `user_token` — `X-Plex-Token` header |
| Plex (community) | `https://raw.githubusercontent.com/LukeHagar/plex-api-spec/main/plex-api-spec.yaml` — behind the Speakeasy SDKs; covers more endpoints (~345 paths) but lags the official version (1.1.1) | YAML | `token` — `X-Plex-Token`; identifying client headers (`X-Plex-Client-Identifier`, `X-Plex-Product`, …) are in `components.parameters` |
| Jellyfin | `https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json` (~2 MB) | JSON | `CustomAuthentication` |
| Emby | `https://swagger.emby.media/openapi.json` (~2 MB) | JSON | `apikeyauth`, `embyauth` — also check per-operation `security` |

Jellyfin and Emby paths are not version-prefixed (`/Items`, `/System/Info`). Per-user item listings differ: Emby documents `/Users/{UserId}/Items`; Jellyfin documents `/Items?userId=` and keeps `/Users/{userId}/Items` only as an obsolete route hidden from its spec (`[ApiExplorerSettings(IgnoreApi = true)]` in Jellyfin's `ItemsController`). The shared client's watch-history scan calls `/Users/{id}/Items` (`jellyfin-base.ts`), which works on both. Tag names differ per spec — list them before filtering by one.

```bash
U=https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json   # or the Emby URL
curl -s $U | jq '.paths | keys'                                    # list paths
curl -s $U | jq '.paths."/Items"'                                  # one endpoint
curl -s $U | jq '.components.schemas.BaseItemDto'                  # a schema
curl -s $U | jq '[.paths[][]? | objects | .tags[]?] | unique'      # list tags
curl -s $U | jq '[.paths | to_entries[] | select(.value | .. | .tags? // [] | index("Library")) | .key]'  # by tag (Emby: "ItemsService")
curl -s $U | jq '.components.securitySchemes'                      # auth

# Official Plex spec, extracted from the Redoc page's embedded state
curl -sL https://developer.plex.tv/pms/ | python3 -c 'import sys,json; h=sys.stdin.read(); s=h[h.index("__redoc_state = ")+16:]; print(json.dumps(json.JSONDecoder().raw_decode(s)[0]["spec"]["data"]))' > plex-openapi.json
jq '.paths | keys' plex-openapi.json                               # then query it like the JSON specs above

# Community Plex spec (YAML; yq is mikefarah v4 — the Python yq has no `-o`)
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

- `src/lib/image-cache/image-cache.ts`: fetch → `sharp` resize → WebP q80 → `<IMAGE_CACHE_DIR>/<aa>/<bb>/<sha256>.webp` (default `/config/cache/images`; two shard levels from the hash), keyed by **library id + normalized artwork URL** (`normalizeCacheUrl` strips Plex's trailing timestamp) **+ width** — rating keys are per server, so the library id is part of the key.
- `src/lib/image-url.ts` (client-safe): widths `CACHE_WIDTH_GRID` 400 (poster/square cards), `CACHE_WIDTH_GRID_WIDE` 640, 800 default, `CACHE_WIDTH_ART` 1920; `parseImageWidth` allow-list (an unlisted `?w=` is ignored and the default width served; 1920 only via `?type=art`); `resolveArtworkPath` (the one `?type=` fallback chain).
- `invalidateCachedUrls(libraryId, urls)` **must purge every width** (`ALL_CACHE_WIDTHS`) and writes `_stats.json` once per call.
- The media server resizes: `fetchImage(path, { width })` uses Plex's photo transcoder (`/photo/:/transcode?url=…&width=W&height=W&minSize=1&upscale=0`, falling back to the raw path on error, non-image or empty body) or Jellyfin/Emby `maxWidth`, sent with `NO_BREAKER_MARK`.
- `sharp.concurrency(1)`; the cache's own file walks and deletes run `FILE_OP_CONCURRENCY` (8) at a time.
- The image proxy (`/api/media/[id]/image`) caches each item's server connection under `image-meta:` (5 min, part of `invalidateMediaCaches()`) and each failed upstream fetch for 60 s under `imageFailureCacheKey(serverUrl, thumbPath)` (`src/lib/cache/invalidate.ts`; the URL encoded so one server's prefix never matches another's). `PUT /api/servers/[id]` drops the failures recorded under the server's previous URL (`invalidateImageFailures`) whenever its URL, token or TLS setting changes; a sync does not (`tests/integration/servers/connection-cache.test.ts`).

