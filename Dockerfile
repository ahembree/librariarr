FROM node:22-alpine AS base
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --shamefully-hoist

FROM base AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm exec prisma generate && pnpm build

# Isolated prisma CLI install with all transitive dependencies
FROM base AS prisma-cli
WORKDIR /opt/prisma
RUN npm init -y > /dev/null 2>&1 && \
    npm install --no-package-lock --no-fund --no-audit prisma

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME="0.0.0.0"

# su-exec for dropping privileges to the configured UID/GID at runtime
RUN apk add --no-cache su-exec curl

# Copy app files owned by node:node (UID 1000:GID 1000).
# All files are world-readable (default Docker COPY permissions: 755/644),
# so any UID/GID can read them without needing a runtime chown.
COPY --chown=node:node --from=builder /app/public ./public
COPY --chown=node:node --from=builder /app/.next/standalone ./
COPY --chown=node:node --from=builder /app/.next/static ./.next/static
COPY --chown=node:node --from=builder /app/prisma ./prisma
COPY --chown=node:node --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --chown=node:node --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --chown=node:node --from=builder /app/node_modules/pg ./node_modules/pg
COPY --chown=node:node --from=builder /app/node_modules/sharp ./node_modules/sharp
COPY --chown=node:node --from=builder /app/node_modules/@img ./node_modules/@img
COPY --from=prisma-cli /opt/prisma /opt/prisma
COPY --chown=node:node --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

EXPOSE 3000
CMD ["sh", "docker-entrypoint.sh"]
