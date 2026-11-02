---
name: merge-dep-prs
description: Evaluate, fix, validate and merge the open Dependabot PRs one at a time until none are left. Use when asked to work through dependency PRs, merge dependabot PRs, or get the dependencies label to zero.
---

# /merge-dep-prs

Merge every open PR labelled `dependencies`, one at a time. Don't treat green CI as approval:
route tests mock the session and external clients, so a breaking runtime change can pass
(iron-session v9 broke every login with only Browser E2E failing).

**Passing lint, types, tests, build and CI is not the evaluation.** Step 1 is. A run that
validated and merged ten PRs without it is a skipped step, not a fast one.

## For each PR

1. **Evaluate before validating. This is a gate: no merge without its written result.**
   - Read the changelog for **every** version between the old and the new one. The PR body is
     often cut off (`... (truncated)`) or names an older version than the lockfile now holds;
     open the linked release notes/CHANGELOG for whatever is missing.
   - Find what actually imports the package: `grep -rn "from \"<pkg>\"\|require(\"<pkg>\")" src e2e tests scripts`.
     If nothing does, find what does. An unused direct dependency means the bump changes
     nothing the app runs (the UI imports Radix through the `radix-ui` umbrella package, so a
     bump of an individual `@radix-ui/react-*` package does not reach a single component),
     and the update that matters is the umbrella one.
   - For every entry that changes behaviour (a removal, a stricter parse, a changed default,
     a new limit, a deprecation), open each call site and decide whether it needs a change.
     Majors and anything touching auth/sessions/HTTP clients get this for every call site.
   - Write the result: one line per behaviour change naming the call site checked and the
     verdict (`no change needed — …` / `changed …`), plus whether the package is used at all.
     It goes into the squash commit body (`commit_message`) in step 5 and into your report
     to the user. A PR with no written evaluation is not ready to merge.
2. Update the branch to main (`update_pull_request_branch`) — the ruleset only merges
   up-to-date branches, so every merge makes the rest stale. On a merge conflict, see below.
3. Check it out and run (with the pnpm version in `packageManager`, installed via
   `npm install -g pnpm@<version>` like the Dockerfile — not corepack):
   `pnpm install --frozen-lockfile && pnpm exec prisma generate`,
   `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test:unit`, integration tests (below),
   `pnpm build`.
4. If code changes are needed, push them to the Dependabot branch.
5. Wait for CI on the final head, including Browser E2E, then squash-merge
   (`expectedHeadSha` must be the full 40-character SHA — `git ls-remote origin <branch>`).
   Take the version for `commit_title` from the lockfile on that head
   (`git show <sha>:pnpm-lock.yaml | grep "^  '<pkg>@"`), never from the PR title or the
   branch name: Dependabot's rebase moves the version without renaming the branch. Put the
   step-1 evaluation in `commit_message`.
6. Check the CI run the merge starts on `main`. If it fails, fix that before the next PR —
   every later PR is built on top of it.

When the list is empty, run `pnpm audit` (root and `docs/`). Dependabot stops at 10 open PRs,
so a security fix can be missing from the list entirely. Fix what can be fixed in one PR of its
own, validated like any other:

- A patched version inside the range the parent already declares: `pnpm update <pkg> …`
  (pnpm 12 updates transitive dependencies by name; `--depth` takes a number, not `Infinity`).
- A patched version that needs a newer direct dependency: bump that dependency within its major.
- Only when neither reaches it: a floor in `pnpm-workspace.yaml` `overrides`, with a comment
  naming the advisory and the path, and only if the parent's code works with that version.
- Report what is left and why: no patched release, blocked by `minimumReleaseAge` (say when it
  clears), or a major the parent does not accept.

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
- A red check is the PR's until proven otherwise. If it really is infrastructure (a download,
  a runner), fix the cause in its own PR rather than re-running until it passes.
