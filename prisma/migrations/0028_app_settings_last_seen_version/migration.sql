-- The app version whose "What's new" dialog the admin last closed. NULL on
-- every existing row: the dialog then shows the running version's notes once.
ALTER TABLE "AppSettings" ADD COLUMN "lastSeenVersion" TEXT;
