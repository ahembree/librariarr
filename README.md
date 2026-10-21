<p align="center">
  <img src=".github/assets/librariarr_hero.png" alt="Librariarr" width="600" />
</p>

<p align="center">
  <a href="https://github.com/ahembree/librariarr/actions/workflows/ci.yml"><img src="https://github.com/ahembree/librariarr/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://hub.docker.com/r/ahembree/librariarr"><img src="https://img.shields.io/docker/pulls/ahembree/librariarr" alt="Docker Hub" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0" /></a>
</p>

> [!WARNING]
> **This software is currently in beta.** There is the potential for bugs, breaking changes, and data loss. Use at your own risk and ensure you have backups of your data.

Media library management for Plex, Jellyfin, and Emby. Browse and filter your libraries, see quality breakdowns and watch history, and build lifecycle rules that act on your media through Sonarr, Radarr, and Lidarr.

**Documentation:** [librariarr.dev](https://librariarr.dev)

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

## Quick Start (Docker Hub)

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

## Development Setup

For contributing to Librariarr. Requires Docker and pnpm.

### 1. Clone and start

```bash
git clone https://github.com/ahembree/librariarr.git && cd librariarr
pnpm docker:dev
```

No `.env` file needed for development: the dev compose file includes defaults.

This builds and starts the Next.js dev server and PostgreSQL, and pushes the Prisma schema to the database on every start. The app is at [http://localhost:3000](http://localhost:3000).

`src/`, `public/`, `prisma/` and the top-level config files are mounted into the container, so changes hot-reload. After a schema change, run `pnpm docker:dev:db:push` (or restart the container).

### pnpm Scripts Reference

| Command | Description |
| - | - |
| `pnpm docker:dev` | Start dev environment (foreground with logs) |
| `pnpm docker:dev:detach` | Start dev environment (background) |
| `pnpm docker:dev:down` | Stop dev environment |
| `pnpm docker:dev:logs` | Tail app container logs |
| `pnpm docker:dev:db:push` | Push schema to DB (no migration files) |
| `pnpm docker:dev:db:migrate` | Run `prisma migrate dev` |
| `pnpm docker:dev:db:studio` | Open Prisma Studio (DB browser) |
| `pnpm docker:dev:db:reset` | Reset DB and re-run all migrations |
| `pnpm docker:dev:seed` | Seed the dev database |
| `pnpm docker:dev:rebuild` | Rebuild and recreate containers |
| `pnpm docker:dev:clean` | Stop containers and delete DB volume |
| `pnpm docs:dev` | Start the documentation site (localhost:4321) |

### Running Tests

Unit tests need no database; everything else requires the dev DB to be running.

```bash
pnpm test                    # Full test suite
pnpm test:watch              # Watch mode
pnpm test:unit               # Unit tests only (no DB needed)
pnpm test:integration        # Integration tests only (requires DB)
pnpm test:coverage           # Run with coverage report
pnpm e2e:docker              # Browser end-to-end tests (Playwright) against the production image
```

## CI/CD (GitHub Actions)

| Workflow | Trigger | Purpose |
| - | - | - |
| `ci.yml` | Push to `main`, PRs | Lint, type check, unit tests, integration tests, Next.js build, Docker image build (not pushed) |
| `e2e.yml` | PRs, manual dispatch | Playwright end-to-end tests against the production image |
| `pr-title-lint.yml` | PRs | Require a Conventional Commit PR title |
| `release-please.yml` | Push to `main` | Maintain the release PR; when a release is created, build and push `latest`, `X.Y.Z`, `X.Y`, `X` and `<sha>` tags and update the Docker Hub description |
| `docker-nightly.yml` | Push to `main`, manual dispatch | Build and push `nightly` and `nightly-<sha>` |
| `docker-publish.yml` | Manual dispatch only | Fallback publish of `latest` and `<sha>` (plus semver tags when dispatched from a version tag), and update the Docker Hub description |
| `docs-deploy.yml` | Push to `main` touching `docs/`, the OpenAPI source or `package.json`; manual dispatch | Build and deploy the docs site to GitHub Pages |

Images are built for `linux/amd64`.

**Required GitHub secrets:**

| Secret | Description |
| - | - |
| `DOCKERHUB_USERNAME` | Your Docker Hub username |
| `DOCKERHUB_TOKEN` | A Docker Hub [access token](https://app.docker.com/settings/personal-access-tokens) with read, write and delete access (needed to update the repository description) |

## Tech Stack

Next.js 16 (App Router), React 19, TypeScript, PostgreSQL 18, Prisma 7, Tailwind CSS v4, shadcn/ui, Graphile Worker, Vitest, Playwright, Docker

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing, and PR guidelines.

## Disclaimers

### No Warranty or Liability

This software is provided **"as is"**, without warranty of any kind. The author is **not responsible** for any data loss, data corruption, security breaches, misconfigurations, or any other damages or negative outcomes that may result from using this software. You use this application entirely at your own risk. This includes, but is not limited to:

- Unintended deletion or modification of media files through lifecycle rules
- Security vulnerabilities or unauthorized access to your media servers
- Data loss from backups that fail to restore
- Any impact to connected services (Plex, Sonarr, Radarr, Lidarr, etc.)

**You are solely responsible** for your own configuration, data, security, and any consequences of running this software in your environment.

### Best-Effort Maintenance

This project is maintained on a **best-effort basis**. There are **no guarantees** regarding:

- Continued development or feature additions
- Timely bug fixes or security patches
- Long-term availability or support
- Compatibility with future versions of connected services

The project may be discontinued at any time without notice.

### AI-Generated Codebase

This codebase was **99.999% written by AI**. All Issues and Pull Requests submitted to this project will also be reviewed and processed using AI (specifically [Claude Code](https://claude.ai/code) by Anthropic). By contributing, you acknowledge that your submissions will be handled by AI tooling.

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE).
