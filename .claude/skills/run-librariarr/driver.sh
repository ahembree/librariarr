#!/usr/bin/env bash
# driver.sh — launch + drive Librariarr from a clean machine.
#
# All paths are absolute to the project root, derived from this script's
# location, so it works whether you `cd` to the repo first or not.

set -Eeuo pipefail

SKILL_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SKILL_DIR}/../../.." && pwd)"
COOKIE_JAR="${SKILL_DIR}/.cookies"
SHOT_DIR="${SKILL_DIR}/screenshots"

BASE_URL="${LIBRARIARR_BASE_URL:-http://localhost:3000}"
ADMIN_USER="${LIBRARIARR_ADMIN_USER:-admin}"
ADMIN_PASS="${LIBRARIARR_ADMIN_PASS:-librariarr-dev-pw-1234}"

# Endpoints used by `smoke`. All return 200 on a fresh install with the
# admin session cookie.
SMOKE_PATHS=(
  /api/auth/check-setup
  /api/system/info
  /api/servers
  /api/settings/auth
)

log() { printf '[run-librariarr] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"
}

cmd_up() {
  need docker
  need curl
  cd "${REPO_ROOT}"
  log "starting dev stack (pnpm docker:dev:detach) …"
  pnpm docker:dev:detach
  log "polling ${BASE_URL}/api/health (up to 120s) …"
  for i in $(seq 1 120); do
    code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "${BASE_URL}/api/health" || true)
    if [ "${code}" = "200" ]; then
      log "ready after ${i}s — ${BASE_URL}"
      return 0
    fi
    sleep 1
  done
  die "app did not become ready within 120s — try: ./driver.sh logs"
}

# Create the first user via /api/auth/setup; if setup is already done
# (HTTP 403), fall through to /api/auth/local/login. Either way we end
# with a session cookie in ${COOKIE_JAR}.
cmd_setup() {
  need curl
  need jq
  mkdir -p "${SKILL_DIR}"
  rm -f "${COOKIE_JAR}"
  local body="{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}"

  log "POST /api/auth/setup as ${ADMIN_USER}"
  local code
  code=$(curl -s -m 10 -o /tmp/run-librariarr-setup.json -w '%{http_code}' \
    -X POST "${BASE_URL}/api/auth/setup" \
    -H 'Content-Type: application/json' \
    -c "${COOKIE_JAR}" \
    -d "${body}")

  case "${code}" in
    200)
      log "setup succeeded; cookie saved to ${COOKIE_JAR}"
      jq -c '.user' /tmp/run-librariarr-setup.json >&2 || true
      return 0
      ;;
    403)
      log "setup already done — falling back to local login"
      ;;
    *)
      log "setup failed (HTTP ${code}); response:"; cat /tmp/run-librariarr-setup.json >&2
      die "unexpected status ${code} from /api/auth/setup"
      ;;
  esac

  rm -f "${COOKIE_JAR}"
  code=$(curl -s -m 10 -o /tmp/run-librariarr-login.json -w '%{http_code}' \
    -X POST "${BASE_URL}/api/auth/local/login" \
    -H 'Content-Type: application/json' \
    -c "${COOKIE_JAR}" \
    -d "${body}")
  if [ "${code}" = "200" ]; then
    log "login succeeded; cookie saved to ${COOKIE_JAR}"
    jq -c '.user' /tmp/run-librariarr-login.json >&2 || true
  else
    log "login failed (HTTP ${code}); response:"; cat /tmp/run-librariarr-login.json >&2
    die "could not authenticate as ${ADMIN_USER} — wrong LIBRARIARR_ADMIN_PASS?"
  fi
}

cmd_smoke() {
  need curl
  [ -s "${COOKIE_JAR}" ] || die "no cookie jar at ${COOKIE_JAR} — run \`./driver.sh setup\` first"
  local failed=0
  for path in "${SMOKE_PATHS[@]}"; do
    local code size
    code=$(curl -s -b "${COOKIE_JAR}" -o /tmp/run-librariarr-smoke.json -w '%{http_code}' "${BASE_URL}${path}")
    size=$(wc -c < /tmp/run-librariarr-smoke.json)
    printf '  HTTP %s  %-25s %4d bytes  %s\n' "${code}" "${path}" "${size}" "$(head -c 100 /tmp/run-librariarr-smoke.json)" >&2
    if [ "${code}" != "200" ]; then failed=$((failed + 1)); fi
  done
  if [ "${failed}" -gt 0 ]; then
    die "${failed} smoke check(s) failed"
  fi
  log "smoke OK"
}

cmd_logs() {
  cd "${REPO_ROOT}"
  local n="${1:-100}"
  docker logs --tail="${n}" librariarr-dev
}

cmd_down() {
  cd "${REPO_ROOT}"
  pnpm docker:dev:down
}

# WIPES THE DB VOLUME — use to force the next `up` to re-run schema push
# and the next `setup` to create a fresh admin.
cmd_clean() {
  cd "${REPO_ROOT}"
  pnpm docker:dev:clean
  rm -f "${COOKIE_JAR}"
}

# Headless screenshot of a path on the running app.
#
# Runs the official Playwright image so we don't have to install Chromium's
# system libs (libnss3 / libnspr4 / libasound2 …) on the host. The Playwright
# container joins the same docker network as the dev stack and reaches the
# app by its compose service name, which works portably across Linux / WSL /
# Docker Desktop without needing `--network=host` or `host.docker.internal`.
#
# First call: docker pulls the ~2GB image. Cached after that.
PLAYWRIGHT_IMAGE="${LIBRARIARR_PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.49.0-jammy}"
APP_CONTAINER="${LIBRARIARR_APP_CONTAINER:-librariarr-dev}"

cmd_screenshot() {
  need docker
  need pnpm
  local path="${1:-/}"
  local out="${2:-${SHOT_DIR}/$(date +%Y%m%d-%H%M%S).png}"
  mkdir -p "$(dirname -- "${out}")"
  [ -s "${COOKIE_JAR}" ] || log "warning: no cookie jar — screenshot will be of the login page (run \`setup\` first)"

  # The Playwright image ships browser binaries + OS deps but no JS package
  # (intentional — you BYO the SDK version). So install the JS half locally
  # and mount it in. --ignore-workspace keeps pnpm from walking up to the
  # main app's lockfile and silently no-op'ing the install.
  if [ ! -d "${SKILL_DIR}/node_modules/playwright" ]; then
    log "installing playwright JS into ${SKILL_DIR} (one-time) …"
    ( cd "${SKILL_DIR}" && pnpm install --ignore-workspace --prefer-offline ) >&2
  fi

  # Discover the docker network the dev app is on so we can join it. Compose
  # picks a network name like `librariarr_default` — don't hard-code it.
  local network
  network=$(docker inspect "${APP_CONTAINER}" \
    --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' 2>/dev/null || true)
  [ -n "${network}" ] || die "could not find docker network for container '${APP_CONTAINER}' — is the dev stack up? (\`./driver.sh up\`)"

  # In-network URL: speak to the app by its container name, not localhost.
  local in_network_url="http://${APP_CONTAINER}:3000"

  # Cookie-jar mount is optional: docker would create an empty dir at the
  # mount point if the source file is missing, which screenshot.mjs would
  # then try to parse as a Netscape jar. Only mount when the file exists.
  local cookie_mount=()
  if [ -s "${COOKIE_JAR}" ]; then
    cookie_mount=(-v "${COOKIE_JAR}:/cookies:ro" -e LIBRARIARR_COOKIE_JAR=/cookies)
  fi

  log "screenshotting ${in_network_url}${path} → ${out}"
  docker run --rm \
    -u "$(id -u):$(id -g)" \
    --network "${network}" \
    -v "${SKILL_DIR}/screenshot.mjs:/screenshot.mjs:ro" \
    -v "${SKILL_DIR}/node_modules:/node_modules:ro" \
    "${cookie_mount[@]}" \
    -v "$(dirname -- "${out}"):/out" \
    -e NODE_PATH=/node_modules \
    -e LIBRARIARR_BASE_URL="${in_network_url}" \
    -e LIBRARIARR_SHOT_PATH="${path}" \
    -e LIBRARIARR_SHOT_OUT="/out/$(basename -- "${out}")" \
    "${PLAYWRIGHT_IMAGE}" \
    node /screenshot.mjs
}

usage() {
  cat <<'EOF' >&2
Usage: ./driver.sh <command> [args]

  up                  Bring up docker dev stack, wait for /api/health 200
  setup               Create or log into the admin user; save session cookie
  smoke               GET a few authenticated endpoints, assert 200
  logs [N]            Tail the app container logs (default 100 lines)
  down                Stop containers (keep DB volume)
  clean               Stop containers AND wipe DB volume + cookie
  screenshot [path] [out]
                      Headless-Chromium screenshot of a path
                      (default: '/'). Installs Playwright on first use.

Environment overrides:
  LIBRARIARR_BASE_URL     default http://localhost:3000
  LIBRARIARR_ADMIN_USER   default admin
  LIBRARIARR_ADMIN_PASS   default librariarr-dev-pw-1234
EOF
  exit 1
}

[ $# -ge 1 ] || usage
sub="$1"; shift || true
case "${sub}" in
  up)         cmd_up "$@" ;;
  setup)      cmd_setup "$@" ;;
  smoke)      cmd_smoke "$@" ;;
  logs)       cmd_logs "$@" ;;
  down)       cmd_down "$@" ;;
  clean)      cmd_clean "$@" ;;
  screenshot) cmd_screenshot "$@" ;;
  *)          usage ;;
esac
