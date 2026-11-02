---
name: backup-restore
description: Backup and restore — createBackup/restoreBackup, BACKUP_TABLE_ORDER, what config-only skips, encryption, session revocation on restore, and which routes need a recent sign-in. Use when changing backups, restore, or adding a Prisma model.
---

# Backup & Restore

`src/lib/backup/backup-service.ts`:

- `createBackup(passphrase?, configOnly=true)` exports tables in FK order (`BACKUP_TABLE_ORDER`), gzips, optionally encrypts (AES-256-GCM; `.json.gz.enc`, else `.json.gz`). A table that cannot be read fails the backup (no file, no prune). Files are mode `0600`, with sidecar `.meta.json` (incl. `configOnly`) so `listBackups()` needn't decompress. `getBackupPassphrase()` returns the saved password; the POST falls back to it.
- **Every table must appear in `BACKUP_TABLE_ORDER`** — restore truncates `"User" CASCADE`, so an omitted table is destroyed and never restored. `tests/unit/backup/table-order.test.ts` pins the list and `BACKUP_EXCLUDED_TABLES` to Prisma's `ModelName`, so a new model must be placed on purpose. `tableToDbName` derives table names from delegate names (no model uses `@@map`). **`ApiKey` is deliberately excluded**: a backup never carries key material and a restore revokes every key (`tests/integration/backup/api-keys-excluded.test.ts`).
- Config-only (default) skips `mediaItem`, `mediaItemExternalId`, `mediaStream`, `syncJob`, `ruleMatch`, `lifecycleAction`, `lifecycleException`, `watchHistory`, `logEntry`; full backup (`configOnly=false`, "Include media data") includes all.
- `restoreBackup(filename, passphrase?, onProgress?)` truncates in reverse FK order and re-inserts in batches of 100 in one transaction, streaming NDJSON progress. A failing TRUNCATE throws naming its table. **A restore never undoes a session revocation**: every restored user gets `sessionVersion = max(file's, in-use, seconds since 2024) + 1` (`revokeRestoredSessions`, `sessionVersionFloor`; `tests/integration/backup/restore-revokes-sessions.test.ts`). Values go to Prisma as the file holds them (`restore-string-values.test.ts`). `deserializeRow` drops columns the schema no longer has (via Prisma's `ScalarFieldEnum`). A rule set referencing a collection the file lacks is detached. Restore also invalidates watch-history evidence (see the `lifecycle` skill).
- **Create, download and restore need a recent sign-in** (see the `auth-security` skill); listing, deleting, scheduled backups and the setup-time `list-setup`/`restore-setup` routes (`SETUP_BUCKET` rate limit) do not. `GET /api/backup/[filename]` sends `Cache-Control: no-store` (`tests/integration/backup/file-permissions.test.ts`).
- Persistent paths are under `/config`: backups `/config/backups`, image cache `/config/cache/images` (`BACKUP_DIR`, `IMAGE_CACHE_DIR`, `LOG_ARCHIVE_DIR` override).
