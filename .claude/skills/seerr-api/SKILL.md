---
name: seerr-api
description: Reference for the Seerr REST API (the project that merges Overseerr and Jellyseerr). Use when adding, debugging, or extending Seerr API calls (requests, search, settings, user/session control, response schemas).
---

# Seerr API

Fetch the Seerr OpenAPI spec from:

https://raw.githubusercontent.com/seerr-team/seerr/refs/heads/main/seerr-api.yml

Seerr is the merger of Overseerr and Jellyseerr; the API surface is the same shape as Overseerr's. Two auth schemes are supported (see `components.securitySchemes`):

- `apiKey` — `X-Api-Key: <apiKey>` header
- `cookieAuth` — sign in via `/auth/plex` or `/auth/local`

**The spec is YAML, not JSON** — use `yq` (mikefarah, v4) to query it directly, or pipe through `yq -o json` into `jq` for jq-style filters:

- List all paths: `curl -sL <url> | yq '.paths | keys'`
- Inspect one endpoint: `curl -sL <url> | yq '.paths."/request"'`
- Look up a schema: `curl -sL <url> | yq '.components.schemas.MediaRequest'`
- Find endpoints by tag: `curl -sL <url> | yq -o json | jq '[.paths | to_entries[] | select(.value | .. | .tags? // [] | index("request")) | .key]'`
- Check auth schemes: `curl -sL <url> | yq '.components.securitySchemes'`
