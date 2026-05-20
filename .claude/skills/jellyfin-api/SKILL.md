---
name: jellyfin-api
description: Reference for the Jellyfin REST API. Use when adding, debugging, or extending Jellyfin API calls (server queries, library/item lookups, playback control, response schemas).
---

# Jellyfin API

Fetch the Jellyfin OpenAPI spec from:

https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json

Jellyfin paths are not version-prefixed (e.g. `/Items`, `/Users/{userId}/Items`, `/System/Info`). Multiple auth schemes are supported — consult `components.securitySchemes` in the spec before assuming a header format.

The spec is large (~2 MB) — never load it whole into context. Use `curl` + `jq` to extract only what you need:

- List all paths: `curl -s <url> | jq '.paths | keys'`
- Inspect one endpoint: `curl -s <url> | jq '.paths."/Items"'`
- Look up a schema: `curl -s <url> | jq '.components.schemas.BaseItemDto'`
- Find endpoints by tag: `curl -s <url> | jq '[.paths | to_entries[] | select(.value | .. | .tags? // [] | index("Items")) | .key]'`
- Check auth schemes: `curl -s <url> | jq '.components.securitySchemes'`
