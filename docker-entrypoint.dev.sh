#!/bin/sh
set -e

PUID=${PUID:-1000}
PGID=${PGID:-1000}
UMASK=${UMASK:-022}
export NEXT_TELEMETRY_DISABLED=1

echo "==> Starting with UID: $PUID, GID: $PGID"
echo "    Setting umask: $UMASK"
umask "$UMASK"

# Resolve or create a group with the target GID
EXISTING_GROUP=$(getent group "$PGID" | cut -d: -f1)
if [ -n "$EXISTING_GROUP" ]; then
  APP_GROUP="$EXISTING_GROUP"
  echo "    Using existing group: $APP_GROUP (GID $PGID)"
else
  addgroup -g "$PGID" appuser
  APP_GROUP="appuser"
  echo "    Created group: appuser (GID $PGID)"
fi

# Resolve or create a user with the target UID
EXISTING_USER=$(getent passwd "$PUID" | cut -d: -f1)
if [ -n "$EXISTING_USER" ]; then
  APP_USER="$EXISTING_USER"
  echo "    Using existing user: $APP_USER (UID $PUID)"
else
  adduser -u "$PUID" -G "$APP_GROUP" -D -h /app -s /bin/sh appuser
  APP_USER="appuser"
  echo "    Created user: appuser (UID $PUID)"
fi

# Ensure writable directories and files are owned by the app user.
# node_modules is read-only (installed during build) — no chown needed.
echo "==> Setting ownership on writable paths..."
mkdir -p /app/.next
chown -R "$PUID:$PGID" /app/.next
mkdir -p /app/src/generated/prisma
chown -R "$PUID:$PGID" /app/src/generated
# Next.js writes next-env.d.ts in the app root during dev startup
touch /app/next-env.d.ts
chown "$PUID:$PGID" /app/next-env.d.ts
echo "    Done."

# Ensure config directories exist and are writable
mkdir -p /config/backups /config/cache/images
chown -R "$PUID:$PGID" /config

echo "==> Generating Prisma client from mounted schema..."
su-exec "$APP_USER" npx prisma generate
echo "    Prisma client generated."

echo "==> Waiting for database to be ready..."
MAX_RETRIES=30
RETRY=0
DB_READY=false

# Use the pg module directly — faster than running prisma db push on every retry
DB_CHECK_SCRIPT='
const { Client } = require("pg");
const c = new Client({ connectionString: process.env.DATABASE_URL });
c.connect()
  .then(() => c.query("SELECT 1"))
  .then(() => { c.end(); process.exit(0); })
  .catch((err) => { console.error("    DB check error: " + err.message); c.end().catch(() => {}); process.exit(1); });
'

while [ "$DB_READY" = "false" ]; do
  if su-exec "$APP_USER" node -e "$DB_CHECK_SCRIPT" 2>&1; then
    DB_READY=true
  else
    RETRY=$((RETRY + 1))
    if [ "$RETRY" -ge "$MAX_RETRIES" ]; then
      echo "    ERROR: Database not reachable after $MAX_RETRIES attempts"
      exit 1
    fi
    echo "    Database not ready yet, retrying in 2s... ($RETRY/$MAX_RETRIES)"
    sleep 2
  fi
done

echo "    Database is ready."

echo "==> Pushing schema to database..."
su-exec "$APP_USER" npx prisma db push --accept-data-loss
echo "    Database schema synced successfully."

# --expose-gc: makes global.gc() available so the sync engine can force
#   collection between pages instead of letting V8 defer it indefinitely.
# --max-old-space-size=4096: Next.js dev server has a built-in memory
#   watchdog that restarts the process when V8 heap exceeds 80% of the limit.
#   With 4096 MB, the threshold is ~3277 MB, giving the dev server (~1 GB
#   baseline) enough headroom for sync operations (~1-2 GB peak).
export NODE_OPTIONS="--expose-gc --max-old-space-size=4096"

echo "==> Starting dev server as $APP_USER..."
exec su-exec "$APP_USER" npm run dev
