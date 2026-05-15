-- Snapshot of the previous SSO config, taken automatically on every save.
-- Gives admins a one-click "Revert to previous SSO configuration" recovery
-- path that doesn't rely on backup files (which rotate on retention and can
-- end up containing only the broken post-change state). Nullable: initially
-- unset, only populated after the first SSO config change.
ALTER TABLE "AppSettings" ADD COLUMN "previousSsoConfig" JSONB;
