-- API keys for external integrations against /api/v1.
--
-- The raw secret is never stored: only its SHA-256 hex digest lands in
-- "keyHash", and the unique index on it is the authentication lookup path
-- (one indexed equality probe, no scan-and-compare). "prefix" holds the
-- non-secret leading characters so the UI can identify a key after the
-- one-time reveal at creation.
--
-- Revocation is a soft delete ("revokedAt") so the audit trail survives;
-- DELETE removes the row outright. "lastUsedAt" is written at most once per
-- key per minute by the auth path, so a busy integration doesn't turn every
-- request into a write.

-- CreateEnum
CREATE TYPE "ApiKeyScope" AS ENUM ('READ_ONLY', 'READ_WRITE');

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scope" "ApiKeyScope" NOT NULL DEFAULT 'READ_ONLY',
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");
CREATE UNIQUE INDEX "ApiKey_userId_name_key" ON "ApiKey"("userId", "name");

-- AddForeignKey
ALTER TABLE "ApiKey"
    ADD CONSTRAINT "ApiKey_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
