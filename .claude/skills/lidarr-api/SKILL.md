---
name: lidarr-api
description: Reference for the Lidarr v1 REST API. Use when adding, debugging, or extending Lidarr API calls (new endpoints on LidarrClient, query/command payloads, response schemas).
---

# Lidarr API

Fetch the Lidarr v1 OpenAPI spec from:

https://raw.githubusercontent.com/lidarr/Lidarr/master/src/Lidarr.Api.V1/openapi.json

All endpoints are under `/api/v1/*` (note: v1, not v3 like Radarr/Sonarr). Auth is the `X-Api-Key: <apiKey>` header.

The spec is large — do not load it whole into context. Use `curl` + `jq` to extract only what you need:

- List all paths: `curl -s <url> | jq '.paths | keys'`
- Inspect one endpoint: `curl -s <url> | jq '.paths."/api/v1/artist"'`
- Look up a schema: `curl -s <url> | jq '.components.schemas.ArtistResource'`
- Find endpoints by tag: `curl -s <url> | jq '[.paths | to_entries[] | select(.value | .. | .tags? // [] | index("Artist")) | .key]'`
