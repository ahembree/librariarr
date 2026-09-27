-- Notify Discord when an API key is created or deleted. On by default: a key
-- outlives the browser session that minted it, so its creation is the event
-- the admin most needs to hear about, wherever a webhook is configured.

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN "discordNotifyApiKeys" BOOLEAN NOT NULL DEFAULT true;
