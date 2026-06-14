---
name: dependency-prs
description: Safely evaluate, test, and merge open Dependabot dependency PRs ONE AT A TIME with lockfile-integrity guarantees. Use whenever processing/merging PRs labeled `dependencies`, or when asked to "do the dependency PRs", clear the Dependabot queue, or update dependencies.
---

# Dependency PR routine

Process open PRs labeled `dependencies` (Dependabot) for `ahembree/librariarr`,
merging the ones that update cleanly with no code changes or impact.

This skill exists because of a real incident: six lockfile-touching PRs were
batch-merged back-to-back. GitHub 3-way **text**-merged each `pnpm-lock.yaml`,
two bumps stacked the same transitive entry, and the result was a **duplicate
YAML key**. PyYAML tolerated it; pnpm did not. `pnpm install --frozen-lockfile`
(used by CI **and** the Dockerfile) failed, so `main`, nightly Docker, and
releases all went red — and Dependabot could no longer rebase anything.

The rules below make that impossible **if followed exactly**. Do not optimize
them away for speed. If you find yourself wanting to merge a second PR before
re-validating the base, stop and re-read Cardinal rule #1.

---

## Cardinal rule #1 — ONE PR at a time. Never batch.

- Merge **exactly one** dependency PR, then **fully re-establish a known-good
  base** before touching the next.
- After a merge, **every other open dependency PR is now behind** and MUST be
  rebased/recreated against the new base and re-validated **before** it may be
  merged.
- **Never** merge a second lockfile-touching PR while any other is behind. There
  is no exception for "they look independent" — independent top-level bumps still
  share transitive subtrees in the lockfile.

## Cardinal rule #2 — The lockfile is the source of truth, and it is fragile.

- GitHub's `mergeable == clean` / a successful merge button does **NOT** prove
  the merged lockfile is valid. Git merges lockfiles as plain text and will
  happily produce a structurally-invalid lockfile (duplicate keys) that still
  "merges cleanly."
- The **only** proof a lockfile is good is running the package manager against it:
  `pnpm install --frozen-lockfile` (this repo). It must pass **before** merge (on
  the PR head) **and after** merge (on the updated base).
- If either frozen install fails: **STOP**. Do not continue the loop. Fix the
  base first.

## Cardinal rule #3 — Commit identity.

- Any commit you author/push uses the GitHub **noreply** email
  (`<numeric-id>+<login>@users.noreply.github.com`). Get the id/login from the
  GitHub API (`get_me`) — **never** from ambient session context.
- **Never** author a commit with a personal email (e.g. an `@gmail.com` address),
  even if one is provided to you. Personal emails must not enter public commit
  history.

---

## Per-PR procedure (run for ONE PR, start to finish)

1. **Select** the oldest open PR labeled `dependencies`, authored by
   `dependabot[bot]`, targeting the default branch (`main`).
2. **Make it current.** If the PR branch is behind `main`, rebase it first
   (`@dependabot rebase`, or manual rebase per the fallback below). Wait until
   its head is rebased onto the latest `main`. Do not evaluate a stale branch.
3. **CI gate.** Confirm **all required checks** are green on the PR's *current*
   head SHA: Lint & Type Check, Unit Tests, Integration Tests, Build, Docker
   Build, Browser E2E. `CodeQL` `neutral` is acceptable.
   - Third-party statuses that report a **quota/limit** rather than a code result
     (e.g. Snyk "Code test limit reached") are **not** a pass and **not** a code
     failure — flag to the user; only block if it is a *required* status.
4. **Lockfile gate (pre-merge).** Check out the PR head and run
   `pnpm install --frozen-lockfile`. It must succeed. If it fails, the PR's own
   lockfile is bad — request `@dependabot recreate` and move on; do not merge.
5. **Merge — one, and in a way that avoids a 3-way lockfile merge.** Because the
   branch is up to date (step 2), use **squash** merge with a Conventional-Commit
   title (`<type>(scope): … (#NUMBER)`). An up-to-date branch means the lockfile
   lands as-tested, not as a text-merge.
6. **Lockfile gate (post-merge).** Pull the updated `main` and run
   `pnpm install --frozen-lockfile` again. **This is the backstop.** If it fails,
   the merge corrupted the base — revert the merge or push a regenerated-lockfile
   fix immediately, and **halt the loop** until `main` is green.
7. **Only now** return to step 1 for the next PR (which must be re-made-current
   per step 2 before it can proceed).

## Manual rebase fallback (Dependabot can't rebase)

Dependabot refuses ("can't parse your pnpm-lock.yaml") when the **base**
lockfile is invalid, or for unsupported lockfile versions. To rebase by hand
without re-floating every dependency:

1. Start from the **last known-good** lockfile (e.g. the pre-incident commit) and
   the target branch's current `package.json`.
2. `pnpm install --lockfile-only` — pnpm preserves existing resolutions and only
   updates the changed specifiers' subtrees → minimal, correct diff.
3. Validate: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test:unit`.
4. Commit with the noreply identity (rule #3) and push.

## Cadence / looping

- One merge per cycle. Re-poll on an interval (default ~60 min, or when CI events
  arrive). Stop when no open `dependencies` PRs remain.
- Webhooks do **not** deliver CI-success, new pushes, or merge transitions —
  re-poll the base's health and each PR's checks each cycle rather than assuming.

## Definition of done

- All open `dependencies` PRs are merged **or** explicitly deferred/closed.
- `main` passes `pnpm install --frozen-lockfile` (verified, not assumed).
- No commit in the pushed history uses a personal email.

---

## Strongest safeguard — make the platform enforce rule #1

The most durable guarantee is a branch-protection rule on `main`:
**"Require branches to be up to date before merging."** With it enabled, GitHub
*mechanically blocks* merging any PR that is behind the base, forcing the
rebase-and-revalidate step in this routine and making a silent 3-way lockfile
merge impossible. Recommend enabling it (and keeping the required status checks
above) so the routine is enforced even outside this skill.
