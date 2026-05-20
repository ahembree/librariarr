---
name: emby-api
description: Reference for the Emby REST API. Use when adding, debugging, or extending Emby API calls (server queries, library/item lookups, playback control, response schemas).
---

# Emby API

Fetch the Emby OpenAPI spec from:

https://swagger.emby.media/openapi.json

Emby paths are not version-prefixed (e.g. `/Items`, `/Users/{Id}/Items`, `/System/Info`). Multiple auth schemes are supported — consult `components.securitySchemes` (and per-operation `security`) in the spec before assuming a header format.

The spec is large (~2 MB) — never load it whole into context. Use `curl` + `jq` to extract only what you need:

- List all paths: `curl -s <url> | jq '.paths | keys'`
- Inspect one endpoint: `curl -s <url> | jq '.paths."/Items"'`
- Look up a schema: `curl -s <url> | jq '.components.schemas.BaseItemDto'`
- Find endpoints by tag: `curl -s <url> | jq '[.paths | to_entries[] | select(.value | .. | .tags? // [] | index("Items")) | .key]'`
- Check auth schemes: `curl -s <url> | jq '.components.securitySchemes'`
