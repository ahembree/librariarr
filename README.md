# Librariarr

[![CI](https://github.com/ahembree/librariarr/actions/workflows/ci.yml/badge.svg)](https://github.com/ahembree/librariarr/actions/workflows/ci.yml)
[![Docker Hub](https://img.shields.io/docker/pulls/ahembree/librariarr)](https://hub.docker.com/r/ahembree/librariarr)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

> [!WARNING]
> **This software is currently in beta.** There is the potential for bugs, breaking changes, and data loss. Use at your own risk and ensure you have backups of your data.

Media library management for Plex, Jellyfin, and Emby. Track your media metadata, monitor quality breakdowns, and build lifecycle rules to manage your libraries.

**Documentation:** [librariarr.dev](https://librariarr.dev)

## Features

- **Authentication** — Sign in with Plex OAuth (auto-discovery) or local credentials
- **Dashboard** — Customizable layout with drag-to-reorder cards, tabs for Movies/Series/Music, quality breakdowns, storage stats
- **Library Browser** — Filterable views for movies, series, and music with 20+ filters, virtual scrolling, grid and table modes, alphabet navigation
- **Detail Panel** — Slide-out panel with full metadata: video, audio, file info, subtitles, watch history
- **Lifecycle Rules** — Rule builder with recursive AND/OR groups, 50+ fields, actions (delete, unmonitor, tag), and Plex collection sync
- **Stream Manager** — Active session monitoring, maintenance mode with configurable delay, transcode management, blackout schedules
- **Preroll Manager** — Preroll presets with file validation, recurring/one-time schedules, combine modes (Plex Pass required)
- **Backup & Restore** — Manual or scheduled backups with optional AES-256-GCM encryption and configurable retention
- **Notifications** — Discord webhook notifications for lifecycle actions and maintenance mode changes
- **Scheduling** — Configurable schedules for media sync, lifecycle detection, and lifecycle execution
- **Multi-Server** — Connect multiple Plex, Jellyfin, or Emby servers with automatic deduplication
- **Integrations** — Sonarr, Radarr, and Lidarr for lifecycle actions; Seerr for request-aware rules

## Quick Start (Docker Hub)

Pull the pre-built image and run with Docker Compose.

### 1. Create a directory and config files

```bash
mkdir librariarr && cd librariarr
```

Create a `.env` file:

```env
# Required — generate a random 32+ character string for session encryption
SESSION_SECRET="your-random-secret-here"
```

### 2. Create docker-compose.yml

```yaml
services:
  librariarr:
    image: ahembree/librariarr:latest
    container_name: librariarr
    ports:
      - "${LIBRARIARR_PORT:-3000}:3000"
    environment:
      - DATABASE_URL=postgresql://librariarr:librariarr@librariarr-db:5432/librariarr
      - SESSION_SECRET=${SESSION_SECRET}
      - NEXT_TELEMETRY_DISABLED=1
      - TZ=${TZ:-UTC}
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
      POSTGRES_PASSWORD: librariarr
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

### 3. Start

```bash
docker compose up -d
```

Open [http://localhost:3000](http://localhost:3000). You'll be directed to the login page where you can sign in with Plex or create local credentials.

Database migrations run automatically on container start.

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `SESSION_SECRET` | Yes | Random 32+ character string for session encryption |
| `DATABASE_URL` | Yes | PostgreSQL connection string (set automatically if using the provided compose file) |
| `PUID` | No | UID to run the app process as (default: `1000`) |
| `PGID` | No | GID to run the app process as (default: `1000`) |
| `LIBRARIARR_PORT` | No | Host port to expose (default: `3000`) |
| `TZ` | No | IANA timezone for scheduled jobs (default: `UTC`) |
| `LOG_DEBUG` | No | Enable debug-level logging (default: `false`) |
| `BACKUP_DIR` | No | Override backup storage location (default: `/config/backups`) |
| `IMAGE_CACHE_DIR` | No | Override image cache location (default: `/config/cache/images`) |

## Development Setup

For contributing to Librariarr. Requires Docker and npm.

### 1. Clone and start

```bash
git clone https://github.com/ahembree/librariarr.git && cd librariarr
npm run docker:dev
```

No `.env` file needed for development — the dev compose file includes sensible defaults.

This builds and starts the Next.js dev server and PostgreSQL. The app is at [http://localhost:3000](http://localhost:3000).

Source code in `src/`, `public/`, and `prisma/` is mounted into the container, so changes trigger hot-reload automatically.

### 2. Database commands

On first start (or after schema changes):

```bash
npm run docker:dev:db:push
```

### npm Scripts Reference

| Command | Description |
| --- | --- |
| `npm run docker:dev` | Start dev environment (foreground with logs) |
| `npm run docker:dev:detach` | Start dev environment (background) |
| `npm run docker:dev:down` | Stop dev environment |
| `npm run docker:dev:logs` | Tail app container logs |
| `npm run docker:dev:db:push` | Push schema to DB (no migration files) |
| `npm run docker:dev:db:migrate` | Run Prisma migrations |
| `npm run docker:dev:db:studio` | Open Prisma Studio (DB browser) |
| `npm run docker:dev:db:reset` | Reset DB and re-run all migrations |
| `npm run docker:dev:rebuild` | Rebuild containers from scratch |
| `npm run docker:dev:clean` | Stop containers and delete DB volume |

### Running Tests

Requires the dev DB to be running.

```bash
npm test                    # Full test suite
npm run test:unit           # Unit tests only (no DB needed)
npm run test:integration    # Integration tests only (requires DB)
npm run test:coverage       # Run with coverage report
```

## CI/CD (GitHub Actions)

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `ci.yml` | Push to `main`, PRs | Lint, type check, unit tests, integration tests, build |
| `docker-publish.yml` | Push to `main`, version tags (`v*`) | Build and push Docker image to Docker Hub |
| `docs-deploy.yml` | Push to `main` (`docs/**` changes) | Build and deploy docs to GitHub Pages |

**Docker image triggers:**

- Push to `main` → tagged as `latest`
- Version tags (`v1.0.0`) → tagged as `1.0.0`, `1.0`, `1`, and the commit SHA
- Manual dispatch via GitHub Actions UI

**Platforms:** linux/amd64, linux/arm64

**Required GitHub secrets:**

| Secret | Description |
| --- | --- |
| `DOCKERHUB_USERNAME` | Your DockerHub username |
| `DOCKERHUB_TOKEN` | A DockerHub [access token](https://hub.docker.com/settings/security) |

## Tech Stack

Next.js 16 (App Router), React 19, TypeScript, PostgreSQL 18, Prisma 7, Tailwind CSS v4, shadcn/ui, Docker

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
