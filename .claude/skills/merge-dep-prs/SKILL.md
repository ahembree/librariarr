---
name: merge-dep-prs
description: Evaluate, fix, validate and merge the open Dependabot PRs one at a time until none are left. Use when asked to work through dependency PRs, merge dependabot PRs, or get the dependencies label to zero.
---

# /merge-dep-prs

Work every open PR labelled `dependencies` to merged, one at a time, in a loop.

**The premise of this skill: a green CI run is not permission to merge.** Route tests mock
`@/lib/auth/session`, `@/lib/db` and every external client, so a dependency whose runtime
contract changed can pass all six required checks and still break the app for real users.
iron-session v9 did exactly that — every login path threw at runtime, unit and integration
were green, and only Browser E2E caught it. Read the changelog, find the call sites, and
where the risk is real, drive the actual installed package.

## Loop

For each PR (simplest bumps first — patch/dev-only, then minor, then major; docs PRs last
because `docs/package-lock.json` conflicts serialize them anyway):

1. **Read what it actually changes.** `pull_request_read` (method `get`) for the changelog
   Dependabot embeds, and `git diff origin/main...origin/<branch> -- package.json` for the
   real bump. Do not trust the title — see "Titles lie" below.
2. **Bring the branch up to main** (the ruleset requires it — see "Ruleset" below).
3. **Validate locally** with `validate.sh` in this directory. It is the CI job set plus a
   working Postgres, and it is the only place you can iterate quickly.
4. **Assess the runtime contract** for anything the mocks hide (below).
5. **Fix if needed**, push to the Dependabot branch, re-validate.
6. **Wait for CI on the final head**, confirm every check including Browser E2E, then
   squash-merge with an accurate conventional-commit title.
7. Next PR. Its branch is now behind main again — back to step 2.

At the end, re-list open PRs to confirm nothing labelled `dependencies` is left, and run
`validate.sh` once on merged `main`.

## Setup (once per session)

```bash
.claude/skills/merge-dep-prs/validate.sh --setup   # starts Postgres, creates the role/DB
```

`validate.sh` (no args) then runs: `pnpm install --frozen-lockfile`, `prisma generate`,
`pnpm lint`, `tsc --noEmit`, `pnpm test:unit`, integration tests, `pnpm build`.

**Why integration tests need the wrapper.** `tests/setup/global-setup.ts` runs
`prisma db push --accept-data-loss`, which Prisma refuses when it detects an AI agent. Do
not set `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` and do not edit the setup file.
`validate.sh` instead builds `librariarr_test` itself — `prisma migrate deploy` plus the
`migrate diff` script for the schema-only columns `db push` would have added (migrations
lag `schema.prisma` by design; see "Prisma and Database" in CLAUDE.md) — then runs vitest
with `VITEST_SKIP_DB_SETUP=true`. It refuses to apply a diff containing `DROP`/`TRUNCATE`/
`DELETE`, so a schema change that would destroy data stops the run instead of proceeding.

## What the mocks hide — check these by hand

| Dependency of | Mocked away in tests | Check |
|---|---|---|
| `iron-session` | `tests/setup/mock-session.ts` mocks the whole session module | Drive the real package over an in-memory cookie store. Every login path goes through `rotateSession()`; confirm destroy/re-read/save still works |
| `axios` | every Arr/Plex/Seerr/Tracearr client is `vi.mock()`ed | Interceptors, error shape (`err.response.status`), timeout option names |
| `zod` | nothing — but the error *string* contract is untested | `result.error.issues.map(i =>` `${i.path.join(".")}: ${i.message}`)` must still read the same; custom messages must survive |
| `pg` / `graphile-worker` | integration tests do exercise these | Usually genuinely covered |
| `lucide-react` | icons never render in vitest | Every imported name must still exist — the icon check below |
| `next`, `react`, `prisma` | major bumps touch everything | Do not batch these with anything else |

Useful one-offs (run from the repo root so package resolution works; delete the file after):

```bash
# every lucide icon name the app imports still exists
cat > .icon-check.mjs <<'EOF'
import { readFileSync } from "fs"; import { execSync } from "child_process";
import * as icons from "lucide-react";
const files = execSync('grep -rl "lucide-react" --include=*.tsx --include=*.ts src', {encoding:"utf8"}).trim().split("\n");
const names = new Set();
for (const f of files)
  for (const m of readFileSync(f,"utf8").matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']lucide-react["']/g))
    for (let n of m[1].split(",")) { n = n.trim().split(/\s+as\s+/)[0]; if (n) names.add(n); }
const missing = [...names].filter(n => !(n in icons) && !n.startsWith("type "));
console.log(missing.length ? "MISSING: " + missing.join(", ") : `ok — ${names.size} names`);
EOF
node .icon-check.mjs; rm .icon-check.mjs
```

Type-only exports (`LucideIcon`) show as missing to a runtime check — `tsc` covers those.

## Ruleset, and how branches move under you

- Merging requires **6 required checks on a branch that is up to date with main**, so every
  merge invalidates every other PR. Expect one `update_pull_request_branch` + one full CI
  run per PR. A merge attempt on a stale branch fails with
  `405 … 6 of 6 required status checks are expected`.
- **Dependabot force-rebases its own branches** when main moves, which silently reverts a
  local merge you have not pushed. Always `git fetch origin '+refs/heads/dependabot/*:refs/remotes/origin/dependabot/*'`
  (note the `+`) before assuming your local branch matches the remote.
- **Once you push a commit of your own, Dependabot stops managing the branch** — from then
  on every update to main is yours to merge in manually.
- Prefer `update_pull_request_branch` (GitHub merges main in cleanly most of the time). Only
  resolve locally when it returns `merge conflict between base and head`.

## Resolving a lockfile conflict

`pnpm-lock.yaml` conflicts are not worth hand-merging:

```bash
git merge --no-edit origin/main            # resolve package.json by hand: keep BOTH bumps
git checkout origin/main -- pnpm-lock.yaml
pnpm install --lockfile-only               # re-applies this PR's bump onto main's lock
git diff origin/main -- pnpm-lock.yaml | grep '^[-+]' | grep -v '^[-+][-+]' | head
```

That last line is the check that matters: the diff should be the bumped package and nothing
else (orphan-entry pruning is fine and expected).

**`docs/` is npm, not pnpm** (`docs/package-lock.json`, built by `withastro/action`). Relock
it with the **same npm major that wrote main's lockfile** — an older npm silently strips the
`libc` field from optional platform packages, which is a real (if quiet) regression:

```bash
git checkout origin/main -- docs/package-lock.json
cd docs && npx -y npm@12 install --package-lock-only && npm ci && npm run build
```

A docs PR is validated by that build: 31 pages, and MDX components (`sl-steps`,
`starlight-aside`, `expressive-code`) present in `dist/`.

## Titles lie — fix them before squashing

Dependabot rebases a PR onto a newer version without retitling, and **the squash title
becomes the commit subject release-please reads for the changelog**. Always compare the
title against `git diff origin/main -- package.json` and correct it with
`update_pull_request` before merging (seen: a PR titled 1.38.0 that bumped to 1.39.0, and
one titled 0.41.10 that bumped to 0.42.0 — a minor with real breaking changes).

Squash title format: `build(deps): bump <pkg> from <x> to <y> (#<n>)`, `build(deps-dev):`
for devDependencies. Put any fix you had to make in the squash **body**.

## When a PR needs code changes

Fix it on the Dependabot branch; the bump and its fix belong in one commit on main.

- Follow the project's own conventions (CLAUDE.md) — including the test-coverage rule: a new
  or modified file under `src/lib/**` or `src/app/api/**` needs tests.
- **When the failure class is invisible to the mocked tests, add a test that drives the real
  package.** `tests/unit/auth/session-rotation.test.ts` is the worked example: it
  `vi.unmock()`s the session module, runs real iron-session over an in-memory cookie store,
  and asserts the old broken pattern still throws so nobody reintroduces it.
- Update `CLAUDE.md` and `docs/` when the fix establishes a convention or changes a stated
  requirement (the iron-session bump raised the documented Node floor to 22.13 in
  `package.json` engines, `CONTRIBUTING.md` and `docs/.../advanced/development.mdx`).
- Commit with a conventional subject and the session's attribution trailers.

## Reporting

Say which PRs merged, which needed code changes and why, and name anything CI would have
let through. A bump that needed no changes needs no commentary.
