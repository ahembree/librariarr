---
name: radarr-api
description: Reference for the Radarr v3 REST API. Use when adding, debugging, or extending Radarr API calls (new endpoints on RadarrClient, query/command payloads, response schemas).
---

# Radarr API

Fetch the Radarr v3 OpenAPI spec from:

https://raw.githubusercontent.com/Radarr/Radarr/master/src/Radarr.Api.V3/openapi.json

All endpoints are under `/api/v3/*`. Auth is the `X-Api-Key: <apiKey>` header.

The spec is ~300 KB — do not load it whole into context. Use `curl` + `jq` to extract only what you need:

- List all paths: `curl -s <url> | jq '.paths | keys'`
- Inspect one endpoint: `curl -s <url> | jq '.paths."/api/v3/movie"'`
- Look up a schema: `curl -s <url> | jq '.components.schemas.MovieResource'`
- Find endpoints by tag: `curl -s <url> | jq '[.paths | to_entries[] | select(.value | .. | .tags? // [] | index("Movie")) | .key]'`
