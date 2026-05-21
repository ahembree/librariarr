---
name: plex-api
description: Reference for the Plex Media Server REST API. Use when adding, debugging, or extending Plex API calls (library/section queries, sessions, playback, collections, server identity, response schemas).
---

# Plex API

Plex does not publish a stable server-fetchable URL for its OpenAPI spec — the official developer site (https://developer.plex.tv/) only offers it via a browser-side `blob:` URL that changes on every page load and cannot be hit with `curl`.

**Primary (recommended) source — `LukeHagar/plex-api-spec`:**

https://raw.githubusercontent.com/LukeHagar/plex-api-spec/main/plex-api-spec.yaml

This is the community-maintained OpenAPI 3.1 spec that powers the Speakeasy-generated official Plex SDKs. Stable URL, kept in sync with PMS releases.

**Official (volatile) alternative:** browse to https://developer.plex.tv/, click "Download" to save `openapi.json` locally, then query the local file. Use this if the LukeHagar mirror looks stale or you need to verify against the upstream source.

Auth is the `X-Plex-Token: <token>` header (security scheme name `token` in the spec). Most identifying client headers (`X-Plex-Client-Identifier`, `X-Plex-Product`, etc.) are also expected on real calls — check `components.parameters` for the canonical list.

**The spec is YAML, not JSON** — use `yq` (mikefarah, v4) directly, or pipe through `yq -o json` into `jq`:

- List all paths: `curl -sL <url> | yq '.paths | keys'`
- Inspect one endpoint: `curl -sL <url> | yq '.paths."/library/collections"'`
- Look up a schema: `curl -sL <url> | yq '.components.schemas.Metadata'`
- Find endpoints by tag: `curl -sL <url> | yq -o json | jq '[.paths | to_entries[] | select(.value | .. | .tags? // [] | index("Library")) | .key]'`
- List tags / sections of the API: `curl -sL <url> | yq '.tags[].name'`
- Check auth + identifying headers: `curl -sL <url> | yq '{security: .components.securitySchemes, headers: (.components.parameters // {} | to_entries | map(select(.value.in == "header")) | from_entries)}'`
