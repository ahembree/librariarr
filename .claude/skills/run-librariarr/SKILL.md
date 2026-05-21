---
name: run-librariarr
description: Launch, build, run, start, screenshot, or smoke-test the Librariarr Next.js webapp end-to-end. Use when asked to run librariarr, bring up the dev stack, take a screenshot of the dashboard or any UI page, verify a change in the running app, or check that the app boots cleanly.
---

# /run-librariarr

Drive a clean Librariarr dev stack to authenticated dashboard, then verify behaviour via curl smoke checks or headless-Chromium screenshots. The orchestration is `driver.sh` (in this directory); SKILL.md is its man page.

All paths below are relative to the **repo root** (`/opt/git_repos/librariarr`). `driver.sh` resolves the repo root from its own location, so you can invoke it via the absolute path from anywhere.

## Prerequisites

- Docker + Compose v2 (`pnpm docker:dev:*` is the project's standard dev flow).
- `pnpm`, `curl`, `jq`, `node` on `PATH`.
- For screenshots only: just Docker — the official `mcr.microsoft.com/playwright` image carries Chromium and its OS libs. **Do not** install `libnss3`/`libnspr4`/`libasound2` on the host; the skill runs Playwright inside a container.

## Run (agent path)

```bash
./.claude/skills/run-librariarr/driver.sh up      # start docker dev stack, wait for /api/health 200
./.claude/skills/run-librariarr/driver.sh setup   # create/login admin, save session cookie
./.claude/skills/run-librariarr/driver.sh smoke   # hit four authenticated endpoints, assert 200
```

`setup` is idempotent: on a fresh DB it `POST`s `/api/auth/setup` (the same endpoint the onboarding page calls — `[src/app/api/auth/setup/route.ts](src/app/api/auth/setup/route.ts)`); if a user already exists (HTTP 403) it falls through to `/api/auth/local/login`. The session cookie lands at `.claude/skills/run-librariarr/.cookies` and is reused by `smoke` and `screenshot`.

Defaults — override via env:

| Env var | Default |
|-|-|
| `LIBRARIARR_BASE_URL` | `http://localhost:3000` |
| `LIBRARIARR_ADMIN_USER` | `admin` |
| `LIBRARIARR_ADMIN_PASS` | `librariarr-dev-pw-1234` (8-char min per `authSetupSchema`) |
| `LIBRARIARR_APP_CONTAINER` | `librariarr-dev` |
| `LIBRARIARR_PLAYWRIGHT_IMAGE` | `mcr.microsoft.com/playwright:v1.49.0-jammy` |

## Run (human path)

```bash
pnpm docker:dev          # foreground, Ctrl-C to stop
# then visit http://localhost:3000 — onboarding gate on first run, dashboard after
```

Useless headless because the onboarding page expects browser interaction. Use `driver.sh setup` instead.

## Screenshot

```bash
./.claude/skills/run-librariarr/driver.sh screenshot /
./.claude/skills/run-librariarr/driver.sh screenshot /library/movies /tmp/movies.png
```

PNGs land in `.claude/skills/run-librariarr/screenshots/<timestamp>.png` by default. First run does a one-time `pnpm install --ignore-workspace` (Playwright JS, ~5MB) and a one-time `docker pull` of the Playwright image (~2GB). After that, screenshots take a few seconds each.

The screenshot container joins the dev stack's docker network and reaches the app by its compose service name (`http://librariarr-dev:3000`) — not `localhost` — so the same command works under WSL, Docker Desktop, and native Linux without `--network=host` tricks.

## Reset between runs

```bash
./.claude/skills/run-librariarr/driver.sh clean   # stops containers AND wipes DB volume
./.claude/skills/run-librariarr/driver.sh down    # stops containers, keeps DB
./.claude/skills/run-librariarr/driver.sh logs    # tail librariarr-dev container logs
```

`clean` also deletes the saved session cookie since it would point at a now-gone user.

## What `smoke` checks

GET, with the saved session cookie, asserting `HTTP 200` on each. All four return non-empty JSON even on a totally fresh install (no media synced, no servers connected):

- `/api/auth/check-setup` — public; confirms `setupRequired:false`
- `/api/system/info` — authenticated; app version, DB size, migration status
- `/api/servers` — authenticated; returns `{"servers":[]}` until a Plex/Jellyfin/Emby server is linked
- `/api/settings/auth` — authenticated; auth method flags + `localUsername`

Pick these because they don't depend on any user-supplied state. Adding more (media routes, lifecycle, etc.) would require seeding.

## Gotchas

- **`pnpm install` in this skill dir silently no-ops without `--ignore-workspace`.** `pnpm-workspace.yaml` lives at the repo root with global supply-chain config but no `packages:` key. pnpm still walks up and treats the skill dir as part of the parent project, so a bare `pnpm install` reports "Already up to date" against the wrong lockfile. The driver passes `--ignore-workspace` for this exact reason.
- **The official Playwright Docker image ships browsers + OS libs but no Playwright JS package.** That's intentional — you BYO the SDK version. The driver installs `playwright` into the skill dir's `node_modules` and bind-mounts it into the container with `NODE_PATH=/node_modules`.
- **curl's Netscape cookie jar prefixes HttpOnly entries with `#HttpOnly_`.** A naive `!line.startsWith("#")` filter (used by most "parse Netscape cookie jar" snippets) drops the only cookie we care about. `screenshot.mjs` strips the prefix before filtering.
- **Plex login is disabled on a local-only setup.** `/api/auth/setup` creates the admin with `plexLoginEnabled:false` ([src/app/api/auth/setup/route.ts:52](src/app/api/auth/setup/route.ts#L52)) because no Plex account is linked yet. Don't expect the Plex OAuth button on the screenshot of `/login`.
- **DB volume survives `down`.** A second `up` reuses the existing admin user — `setup` will hit the 403 path and log in instead of creating. Use `clean` if you need a virgin DB (slower: re-pushes schema + reruns Prisma generate).
- **`/api/auth/setup` 403 on `setupRequired:false` is the success-case fallthrough**, not an error. The driver logs `"setup already done — falling back to local login"` and continues.
- **Cookie's `domain` is rewritten on injection.** `curl` saves it as `localhost`; the screenshot runs inside the docker network where the host is `librariarr-dev`. `screenshot.mjs` overrides `domain` to match `LIBRARIARR_BASE_URL`'s hostname so the cookie is sent.

## Troubleshooting

| Symptom | Fix |
|-|-|
| `app did not become ready within 120s` from `up` | `./driver.sh logs` — Prisma schema push can take 30-60s on first start; if it's stuck on "Waiting for database", the dev DB container may have failed health checks. `./driver.sh clean && ./driver.sh up`. |
| `setup` returns 500 | Almost always a serializable-isolation conflict from two concurrent setup attempts. Re-run `setup`. |
| `screenshot` says `could not import 'playwright'` | The bind-mount of `node_modules` didn't land. Delete `.claude/skills/run-librariarr/node_modules` and re-run. |
| `screenshot` says `Host system is missing dependencies` | You're running `screenshot.mjs` outside the container. The skill never expects this — use `./driver.sh screenshot`, which runs it inside the Playwright image. |
| `could not find docker network for container 'librariarr-dev'` | Dev stack isn't up. `./driver.sh up` first. |
| `setupRequired:true` after `setup` succeeded | Stale cookie jar from a prior `clean`. The driver clears it on `clean` — if it's still there, `rm .claude/skills/run-librariarr/.cookies && ./driver.sh setup`. |
| Port 3000 already in use on `up` | `docker ps` — another container is bound to it. `./driver.sh down` first, or stop the other container. |

## Files

```
.claude/skills/run-librariarr/
  SKILL.md          ← this file
  driver.sh         ← bash dispatcher (up | setup | smoke | logs | down | clean | screenshot)
  screenshot.mjs    ← Playwright helper called from `driver.sh screenshot`
  package.json      ← declares playwright@1.49.0 (installed via --ignore-workspace)
  .gitignore        ← excludes node_modules/, pnpm-lock.yaml, .cookies, screenshots/
```
