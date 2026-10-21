# Librariarr

Media library management for Plex, Jellyfin, and Emby. Browse and filter your libraries, see quality breakdowns and watch history, and build lifecycle rules that act on your media through Sonarr, Radarr, and Lidarr.

> **Beta software.** Bugs, breaking changes, and data loss are possible. Keep backups.

**Documentation:** [librariarr.dev](https://librariarr.dev)

**Source:** [github.com/ahembree/librariarr](https://github.com/ahembree/librariarr)

## Features

- **Multi-server** — Connect several Plex, Jellyfin, and Emby servers, with automatic deduplication across them
- **Authentication** — Plex OAuth, local credentials, or SSO (OIDC or forward-auth from a reverse proxy)
- **Dashboard** — Library tiles, lifecycle overview, recently added, and a customizable Insights grid with custom chart cards
- **Library browser** — Movies, series, and music with 20+ filters, grid and table views, alphabet navigation, and per-play watch history
- **Query builder** — Search the library with the same criteria as lifecycle rules, add any criterion as a table column, save queries, and act on the results
- **Lifecycle rules** — Recursive AND/OR rule groups over 50+ fields (media, play activity, Arr, Seerr), scheduled actions (delete, unmonitor, tag, search, change quality profile), and Plex collection sync
- **Deletion safeguards** — Exceptions, rules that pause when the data they read is missing, identity checks before acting, and an optional per-run deletion limit
- **Real-time sync** — WebSocket connection to each media server, so new items, deletions, and plays show up without waiting for a scheduled sync
- **Stream Manager** — Active sessions, maintenance mode, transcode manager, and blackout schedules
- **Preroll Manager** — Preroll presets and schedules (Plex Pass required)
- **TRaSH Guide Sync** — Import custom formats, quality profiles, quality sizes, and naming from the TRaSH Guides into Sonarr and Radarr, with a preview before anything is written
- **AI Analysis** — Read-only assistant that answers questions about your library, using OpenAI-compatible providers (including local models) or Anthropic
- **Public API** — `/api/v1` authenticated by scoped API keys, with an OpenAPI document
- **Backup & restore** — Manual or scheduled backups with optional AES-256-GCM encryption
- **Notifications** — Discord webhooks for lifecycle actions, maintenance mode, and API key changes
- **Integrations** — Sonarr, Radarr, Lidarr, Seerr (Overseerr/Jellyseerr), and Tracearr as a watch-history source

## Image Tags

| Tag | Description |
| - | - |
| `latest` | The most recent stable release. Recommended for most users. |
| `X.Y.Z`, `X.Y`, `X` | Specific [releases](https://github.com/ahembree/librariarr/releases). Pin one for reproducible deployments. |
| `nightly` | Rolling build from the latest commit on `main`. Expect occasional breakage and unreleased database migrations; take a backup first. |
| `nightly-<sha>` | Immutable per-commit nightly build. |

## Quick Start

### 1. `docker-compose.yml`

```yaml
services:
  librariarr:
    image: ahembree/librariarr:latest
    container_name: librariarr
    ports:
      - "${LIBRARIARR_PORT:-3000}:3000"
    environment:
      - DATABASE_URL=postgresql://librariarr:${DB_PASSWORD}@librariarr-db:5432/librariarr
      - SESSION_SECRET=${SESSION_SECRET:-}
      - TZ=${TZ:-UTC}
      - PUID=${PUID:-1000}
      - PGID=${PGID:-1000}
    volumes:
      - ./config:/config
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 5s
      start_period: 60s
      retries: 3
    depends_on:
      librariarr-db:
        condition: service_healthy
    restart: unless-stopped

  librariarr-db:
    image: postgres:18-alpine
    container_name: librariarr-db
    environment:
      POSTGRES_USER: librariarr
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: librariarr
    volumes:
      - librariarr-db:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U librariarr"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped

volumes:
  librariarr-db:
```

### 2. `.env`

```bash
# Required: database password (letters and digits only)
DB_PASSWORD=your-secure-db-password

# Optional: session encryption key, 32+ characters (auto-generated if not set)
# SESSION_SECRET=

PUID=1000
PGID=1000
LIBRARIARR_PORT=3000
```

`DB_PASSWORD` goes inside `DATABASE_URL`, so characters such as `@`, `:`, `/`, `#` or `%` break the connection. Postgres reads it only when its volume is first created.

### 3. Start

```bash
docker compose up -d
```

Open `http://your-server:3000` and sign in with Plex or create local credentials. Database migrations run automatically on container start.

Librariarr is meant for your local network. Do not expose it directly to the internet; use a VPN for remote access.

## Environment Variables

| Variable | Default | Description |
| - | - | - |
| `DATABASE_URL` | — | **Required.** PostgreSQL connection URL |
| `SESSION_SECRET` | Auto-generated | 32+ character session key. Saved to `/config/.session-secret` if not set |
| `PUID` / `PGID` | `1000` | User and group the app runs as |
| `UMASK` | `022` | File permission mask |
| `LIBRARIARR_PORT` | `3000` | Host port (compose file) |
| `TZ` | `UTC` | IANA timezone for scheduled jobs |
| `LOG_DEBUG` | `false` | Enable debug logging |
| `BACKUP_DIR` | `/config/backups` | Backup directory |
| `IMAGE_CACHE_DIR` | `/config/cache/images` | Artwork cache directory |
| `LOG_ARCHIVE_DIR` | `/config/logs` | Log archive directory |
| `PREROLL_ALLOWED_PATHS` | `/media,/data,/mnt,/opt/prerolls` | Allowed directory prefixes for preroll files |
| `TRASH_GUIDES_REPO` / `TRASH_GUIDES_REF` | `TRaSH-Guides/Guides` / `master` | Source of the TRaSH Guides |
| `COOKIE_SECURE` | Inferred | Force the session cookie's `Secure` flag on or off |
| `TRUST_PROXY_HEADERS` | `true` | Trust `X-Forwarded-For` for rate limiting. Set `false` when exposed without a proxy |
| `FORWARD_AUTH_SECRET` | — | Required for forward-auth SSO; your proxy sends it in `X-Librariarr-Proxy-Secret` |
| `OIDC_ALLOW_INSECURE_HTTP` | — | Accept an `http://` OIDC issuer on a network host |
| `SSO_DISABLE_OVERRIDE` | — | Break-glass: force SSO off to recover from a lockout |
| `NODE_EXTRA_CA_CERTS` | — | Path to extra CA certificates to trust |

Full reference: [librariarr.dev/docs/getting-started/installation](https://librariarr.dev/docs/getting-started/installation/)

## Persistent Data

Everything except the database lives under `/config`: backups, cached artwork, archived logs, and the auto-generated session secret. All configuration, rules, and media metadata are stored in PostgreSQL. You can also point `DATABASE_URL` at an existing PostgreSQL server; the user needs `CREATE` privileges.

## License

[GNU Affero General Public License v3.0](https://github.com/ahembree/librariarr/blob/main/LICENSE)
