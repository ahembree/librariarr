-- API keys are stored as salted scrypt hashes (`scrypt$N$r$p$salt$hash`) and
-- found by their display prefix, instead of by an unsalted SHA-256 digest.
-- A key issued before cannot be re-hashed (its plaintext was never stored)
-- and can no longer authenticate, so its row is removed rather than left in
-- the list as a key that never works. Create a new key in Settings →
-- Authentication → API Keys.
DELETE FROM "ApiKey" WHERE "keyHash" NOT LIKE 'scrypt$%';

-- CreateIndex
CREATE INDEX "ApiKey_prefix_idx" ON "ApiKey"("prefix");
