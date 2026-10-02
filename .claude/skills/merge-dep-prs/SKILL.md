---
name: merge-dep-prs
description: Evaluate, fix, validate and merge the open Dependabot PRs one at a time until none are left. Use when asked to work through dependency PRs, merge dependabot PRs, or get the dependencies label to zero.
---

# /merge-dep-prs

Merge every open PR labelled `dependencies`, one at a time. Don't treat green CI as approval:
route tests mock the session, DB and external clients, so a breaking runtime change can pass
(iron-session v9 broke every login with only Browser E2E failing).

## For each PR

1. Read the changelog in the PR body and `git diff origin/main...origin/<branch> -- package.json`.
   For a major or anything touching auth/sessions/HTTP clients, find the call sites and check
   the breaking changes against them.
2. Update the branch to main (`update_pull_request_branch`) — the ruleset only merges
   up-to-date branches, so every merge makes the rest stale.
3. Check it out and run: `pnpm install --frozen-lockfile && pnpm exec prisma generate`,
   `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test:unit`, integration tests (below),
   `pnpm build`.
4. If code changes are needed, push them to the Dependabot branch.
5. Wait for CI on the final head, including Browser E2E, then squash-merge.

## Integration tests

The test harness runs `prisma db push --accept-data-loss`, which Prisma blocks for AI agents.
Don't override that. Build the test DB yourself (Postgres: `service postgresql start`, role
`librariarr`/`librariarr`):

```bash
psql -h localhost -U librariarr -d postgres -c "DROP DATABASE IF EXISTS librariarr_test" -c "CREATE DATABASE librariarr_test"
export DATABASE_URL=postgresql://librariarr:librariarr@localhost:5432/librariarr_test
pnpm exec prisma migrate deploy
pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script > /tmp/drift.sql
cat /tmp/drift.sql   # should only add columns/indexes — stop if it drops anything
psql "$DATABASE_URL" -f /tmp/drift.sql
VITEST_SKIP_DB_SETUP=true pnpm exec vitest run tests/integration
```

## Gotchas

- **Lockfile conflicts:** take main's lockfile, then re-apply the bump pinned to the PR's
  exact version — `pnpm add <pkg>@<version> --lockfile-only` (`-D` for dev deps). Plain
  `pnpm install --lockfile-only` resolves to the newest matching version instead.
- **`docs/` uses npm**, not pnpm. Relock with `npx npm@12` (older npm strips `libc` fields)
  and validate with `npm ci && npm run build` in `docs/`.
- **Dependabot force-rebases** its branches when main moves; re-fetch before pushing. Once
  you push to a branch, it stops managing it.
- **Titles go stale** when Dependabot rebases onto a newer version. Check the real version
  before squashing and fix the title — release-please builds the changelog from it.
- `ERR_PNPM_NO_MATURE_MATCHING_VERSION` means the release is under a day old
  (`minimumReleaseAge`). Skip it for now; don't add an exclusion.
