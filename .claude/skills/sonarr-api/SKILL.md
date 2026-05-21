---
name: sonarr-api
description: Reference for the Sonarr v3 REST API. Use when adding, debugging, or extending Sonarr API calls (new endpoints on SonarrClient, query/command payloads, response schemas).
---

# Sonarr API

Fetch the Sonarr v3 OpenAPI spec from:

https://raw.githubusercontent.com/Sonarr/Sonarr/main/src/Sonarr.Api.V3/openapi.json

All endpoints are under `/api/v3/*`. Auth is the `X-Api-Key: <apiKey>` header.

The spec is large — do not load it whole into context. Use `curl` + `jq` to extract only what you need:

- List all paths: `curl -s <url> | jq '.paths | keys'`
- Inspect one endpoint: `curl -s <url> | jq '.paths."/api/v3/series"'`
- Look up a schema: `curl -s <url> | jq '.components.schemas.SeriesResource'`
- Find endpoints by tag: `curl -s <url> | jq '[.paths | to_entries[] | select(.value | .. | .tags? // [] | index("Series")) | .key]'`
