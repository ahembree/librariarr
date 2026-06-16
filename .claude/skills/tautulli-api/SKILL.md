---
name: tautulli-api
description: Reference for the Tautulli API (Plex monitoring/stats). Use when adding, debugging, or extending Tautulli API calls (watch history ingestion, per-session stream/transcode data, response schemas).
---

# Tautulli API

Tautulli has **no OpenAPI/Swagger spec** — it is documented in a wiki. Reference:

- API reference (commands + params): https://github.com/Tautulli/Tautulli/wiki/Tautulli-API-Reference
- Raw markdown (greppable with `curl`): https://raw.githubusercontent.com/wiki/Tautulli/Tautulli/Tautulli-API-Reference.md

```bash
# Dump the command list / find a command's params without loading the whole page into context
curl -sL https://raw.githubusercontent.com/wiki/Tautulli/Tautulli/Tautulli-API-Reference.md | grep -nA 30 '### get_history'
curl -sL https://raw.githubusercontent.com/wiki/Tautulli/Tautulli/Tautulli-API-Reference.md | grep -nA 30 '### get_stream_data'
```

## Request shape

Every call is a GET against a single endpoint with the command in the `cmd` query param:

```
GET {baseUrl}/api/v2?apikey={apiKey}&cmd={command}&{...params}&out_type=json
```

- **Auth:** `apikey` query param (Settings → Web Interface → API in Tautulli). There is no header auth.
- `out_type=json` is the default but pass it explicitly.
- `baseUrl` is the Tautulli root (e.g. `http://host:8181`), **not** the Plex URL.

## Response envelope

All responses wrap the payload in `response`:

```jsonc
{ "response": { "result": "success", "message": null, "data": { /* command-specific */ } } }
```

- `result` is `"success"` or `"error"`; on error `message` holds the reason. **Always check `result` before reading `data`** — a 200 with `result: "error"` is the failure mode, not an HTTP status.
- For list commands (`get_history`) `data` is `{ recordsFiltered, recordsTotal, data: [ ...rows ], draw }` — the rows are at `response.data.data`.

## Commands used by librariarr

### `get_history` — paged watch-history rows (one logical play per row)
Key params: `grouping` (1 = collapse pause-split segments into one logical play via `reference_id`), `after` / `before` / `start_date` (`YYYY-MM-DD`), `start` + `length` (paging), `order_column` (`date`) + `order_dir` (`asc`/`desc`), `user`/`user_id`, `rating_key`/`grandparent_rating_key`, `media_type`, `transcode_decision`, `guid`.

Each row includes a stable **`row_id`** and a **`reference_id`** (group anchor for paused/continued segments), plus: `rating_key`, `grandparent_rating_key`, `user`/`user_id`/`friendly_name`, `date`/`started`/`stopped`, `play_duration`, `paused_counter`, `percent_complete`, `watched_status`, `ip_address`, `location`, `secure`, `relayed`, `platform`/`player`/`product`, `transcode_decision`/`video_decision`/`audio_decision`, `bitrate`, `quality_profile`, `stream_video_resolution`/`stream_video_height`/`stream_video_width`.

Incremental ingest: order `date asc`, page with `start`/`length`, window with `after`. Re-runs are idempotent on `row_id`.

### `get_stream_data` — per-session source→delivered detail (one row at a time)
Params: `row_id` (a `get_history` row) **or** `session_key` (a live session). Returns source-vs-stream codecs/bitrates/decisions:
`transcode_hw_decoding`, `transcode_hw_encoding`, `video_decision`/`audio_decision`/`subtitle_decision`, `stream_video_decision`/`stream_audio_decision`/`stream_container_decision`/`stream_subtitle_decision`, `container`/`stream_container`, `video_codec`/`stream_video_codec`, `audio_codec`/`stream_audio_codec`, `subtitle_codec`, `bitrate`/`stream_bitrate`, `video_bitrate`/`stream_video_bitrate`, `audio_bitrate`/`stream_audio_bitrate`, `video_resolution`/`stream_video_resolution`, `video_dynamic_range`/`stream_video_dynamic_range`, `audio_channels`/`stream_audio_channels`.
One API call per history row — fetch lazily (e.g. only when `transcode_decision != "direct play"`).

### `get_server_info` / `arnold` — connectivity check
`get_server_info` returns the monitored Plex server's identity (`pms_name`, `pms_identifier`, `pms_version`) — use it for test-connection. (`arnold` just returns a quote; lighter but less informative.)

## Correlation to Plex / librariarr
Rows carry `rating_key` (+ `grandparent_rating_key`) and `guid` — join to `MediaItem.ratingKey`, falling back to `MediaItemExternalId` (TMDB/TVDB/IMDB parsed from `guid`). `user` maps to `WatchHistory.serverUsername`. Plex's own `historyKey` ↔ Tautulli `row_id` are different id spaces — store both, never assume one equals the other.
