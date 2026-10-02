---
name: merge-dep-prs
description: Evaluate, fix, validate and merge the open Dependabot PRs one at a time until none are left. Use when asked to work through dependency PRs, merge dependabot PRs, or get the dependencies label to zero.
---

# /merge-dep-prs

Merge every open PR labelled `dependencies`, one at a time. Don't treat green CI as approval:
route tests mock the session and external clients, so a breaking runtime change can pass
(iron-session v9 broke every login with only Browser E2E failing).

## For each PR

1. Read the changelog in the PR body and `git diff origin/main...origin/<branch> -- package.json`.
   For a major or anything touching auth/sessions/HTTP clients, find the call sites and check
   the breaking changes against them.
2. Update the branch to main (`update_pull_request_branch`) — the ruleset only merges
   up-to-date branches, so every merge makes the rest stale. On a merge conflict, see below.
3. Check it out and run (with the pnpm version in `packageManager`, installed via
   `npm install -g pnpm@<version>` like the Dockerfile — not corepack):
   `pnpm install --frozen-lockfile && pnpm exec prisma generate`,
   `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test:unit`, integration tests (below),
   `pnpm build`.
4. If code changes are needed, push them to the Dependabot branch. Known one: a
   `@playwright/test` bump must also move the image tag in `docker-compose.e2e.yml`.
5. Wait for CI on the final head, including Browser E2E, then squash-merge
   (`expectedHeadSha` must be the full 40-character SHA — `git ls-remote origin <branch>`).

When the list is empty, run `pnpm audit` (root and `docs/`). Dependabot stops at 10 open PRs,
so a security fix can be missing from the list entirely.

## Integration tests

The test harness runs `prisma db push --accept-data-loss`, which Prisma blocks for AI agents.
Don't override that. Build the test DB yourself:

```bash
service postgresql start
su postgres -c "psql -c \"CREATE ROLE librariarr LOGIN SUPERUSER PASSWORD 'librariarr'\"" # first run only
export PGPASSWORD=librariarr
psql -h localhost -U librariarr -d postgres -c "DROP DATABASE IF EXISTS librariarr_test" -c "CREATE DATABASE librariarr_test"
export DATABASE_URL=postgresql://librariarr:librariarr@localhost:5432/librariarr_test
pnpm exec prisma migrate deploy
pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script > /tmp/drift.sql
cat /tmp/drift.sql   # should only add columns/indexes — stop if it drops anything
psql "$DATABASE_URL" -f /tmp/drift.sql
VITEST_SKIP_DB_SETUP=true pnpm exec vitest run tests/integration
```

## Gotchas

- **Lockfile conflicts:** merge main (keep both sides' bumps if `package.json` conflicts),
  take main's lockfile, then pin the PR's exact version —
  `pnpm add <pkg>@<version> --lockfile-only` (`-D` for dev deps). pnpm 12 writes that as an
  exact range, so put package.json back to the range the PR used (`^<version>`, or exact for
  the packages pinned exactly: `react`, `react-dom`, `next`, `eslint-config-next`) and run
  `pnpm install --lockfile-only`; it keeps the pinned version. Skipping the pin (plain
  `pnpm install --lockfile-only` on the merged range) resolves to the newest matching release
  instead of the PR's.
- **`docs/` is a separate pnpm project** with its own `docs/pnpm-lock.yaml` and
  `docs/pnpm-workspace.yaml`. Resolve its conflicts the same way from inside `docs/`, and
  validate with `pnpm install --frozen-lockfile && pnpm build` there.
- **Dependabot force-rebases** its branches when main moves; re-fetch before pushing. Once
  you push to a branch, it stops managing it.
- **Titles go stale** when Dependabot rebases onto a newer version. Check the real version
  before squashing and fix the title — release-please builds the changelog from it.
- `ERR_PNPM_NO_MATURE_MATCHING_VERSION` means the release is under a day old
  (`minimumReleaseAge`). Skip it for now; don't add an exclusion.
- **E2E failing in about 2 minutes with `next/font/google queries have exactly one entry`** is
  the image build failing to download Google Fonts, not the PR. Re-run the failed job once.
