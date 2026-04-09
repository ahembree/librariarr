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

# Ensure config directories exist and are writable
mkdir -p /config/backups /config/cache/images
chown -R "$PUID:$PGID" /config

# Log the database connection target (mask password)
DB_DISPLAY=$(echo "$DATABASE_URL" | sed 's|://[^:]*:[^@]*@|://***:***@|')
echo "==> Database URL: $DB_DISPLAY"

echo "==> Waiting for database to be ready..."
MAX_RETRIES=30
RETRY=0
DB_READY=false

# Use the pg module directly — more reliable than prisma CLI for connectivity checks
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

echo "==> Applying schema..."

# Prisma CLI is installed at /opt/prisma (isolated from the app's node_modules).
# NODE_PATH allows prisma.config.ts to resolve "prisma/config" from the isolated install.
export NODE_PATH=/opt/prisma/node_modules
PRISMA="node /opt/prisma/node_modules/prisma/build/index.js"

# 1. Try migrate deploy first (handles projects with migration files).
#    Fall back to db push if migrations fail (e.g. tables already exist
#    from a previous db-push-only install).
if su-exec "$APP_USER" $PRISMA migrate deploy --schema ./prisma/schema.prisma 2>&1; then
  echo "    Migrations applied successfully."
else
  echo "    Migrate deploy failed, falling back to prisma db push..."
fi

# 2. Always run db push to apply schema-only column additions that aren't
#    covered by migration files. This is non-destructive: it only adds
#    missing columns and indexes without dropping or recreating tables.
su-exec "$APP_USER" $PRISMA db push --skip-generate --schema ./prisma/schema.prisma 2>&1
echo "    Schema is up to date."

# --expose-gc: makes global.gc() available so the sync engine can force
#   collection between pages instead of letting V8 defer it indefinitely.
# --max-old-space-size=2048: lowers the heap ceiling so V8's automatic GC
#   kicks in sooner. The app's working set is ~300-500 MB; 2 GB leaves
#   plenty of headroom while preventing the lazy-GC balloon to 4+ GB.
export NODE_OPTIONS="--expose-gc --max-old-space-size=2048"

echo "==> Starting application as $APP_USER..."
exec su-exec "$APP_USER" node server.js
