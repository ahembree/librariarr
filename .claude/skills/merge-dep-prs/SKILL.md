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

For each PR (simplest bumps first — patch/dev-only, then minor, then major; docs PRs last —
they are isolated from the app lockfile, so they neither block nor are blocked by the rest,
though they do conflict with each other):

1. **Read what it actually changes.** `pull_request_read` (method `get`) for the changelog
   Dependabot embeds, and `git diff origin/main...origin/<branch> -- package.json` for the
   real bump. Do not trust the title — see "Titles lie" below.
2. **Bring the branch up to main** (the ruleset requires it — see "Ruleset" below).
3. **Check the branch out and run the checks** — `git checkout -B pr<n> origin/<branch>`,
   then the commands under "Running the checks". Running them on `main` validates nothing.
4. **Assess the runtime contract** for anything the mocks hide (below).
5. **Fix if needed**, push to the Dependabot branch, re-validate.
6. **Wait for CI on the final head**, confirm every check including Browser E2E, then
   squash-merge with an accurate conventional-commit title.
7. Next PR. Its branch is now behind main again — back to step 2.

At the end, re-list open PRs to confirm nothing labelled `dependencies` is left, and run the
checks once on merged `main`.

## Running the checks

Run these directly and read their output — there is no wrapper, so a failure shows you the
failure rather than the last three lines of it.

```bash
pnpm install --frozen-lockfile && pnpm exec prisma generate
pnpm lint
pnpm exec tsc --noEmit
pnpm test:unit

.claude/skills/merge-dep-prs/prepare-test-db.sh          # builds librariarr_test; see below
VITEST_SKIP_DB_SETUP=true pnpm exec vitest run tests/integration

DATABASE_URL="postgresql://build:build@localhost/build" pnpm build
```

**That is four of the six required checks.** Docker Build and **Browser E2E** are not run
locally: `pnpm e2e:docker` needs a Docker daemon and the cloud container has none (`docker`
is on PATH, but `/var/run/docker.sock` does not exist). E2E is the job that catches what the
mocks hide, so for anything touching auth, sessions or a runtime contract, push and read the
Browser E2E result on the final head before merging — that is the check that failed on the
unfixed iron-session branch while the other five passed.

**Why the test DB needs the script.** `tests/setup/global-setup.ts` runs
`prisma db push --accept-data-loss`, which Prisma refuses when it detects an AI agent. Do not
set `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` and do not edit the setup file.
`prepare-test-db.sh` builds `librariarr_test` instead — `migrate deploy` plus the
`migrate diff` script for the schema-only columns `db push` would have added (migrations lag
`schema.prisma` by design; see "Prisma and Database" in CLAUDE.md) — and refuses to apply a
diff carrying a data-losing statement. That refusal is not protecting the test database, which
is empty; it is a preview of production boot. `docker-entrypoint.sh` runs `prisma db push`
without `--accept-data-loss` and exits if it fails, and Prisma throws rather than apply a
change it expects to lose data — so a refusal here means this commit's image would not start
against an install whose tables hold rows. Dependabot never edits `schema.prisma`: if it fires,
run it on `main` too. Firing there as well means it is pre-existing (report it, it is not this
PR's); firing only on the PR means the bump changed how Prisma diffs. It also starts Postgres
and creates the role on first run.

The two scripts in this directory — this one and `lock-changes.mjs` — exist because each is
fiddly and runs once per PR. Everything else is a plain command; run it directly.

## What the mocks hide — check these by hand

| Dependency of | Mocked away in tests | Check |
|---|---|---|
| `iron-session` | `tests/setup/mock-session.ts` mocks the whole session module | Drive the real package over an in-memory cookie store. Every login path goes through `rotateSession()`; confirm destroy/re-read/save still works |
| `axios` | every Arr/Plex/Seerr/Tracearr client is `vi.mock()`ed | Interceptors, error shape (`err.response.status`), timeout option names |
| `zod` | nothing — but the `details[]` *string* contract is untested | `validateRequest` joins each issue as path-dot-path + ": " + message. Parse a deliberately invalid body and confirm custom messages survive and nested paths still render as `a.b.0` |
| `pg` | `tests/integration/jobs/recover-locks.test.ts` uses a real `Pool` | Genuinely covered |
| `graphile-worker` | only `runMigrations` is real; `run`, `parseCrontab` and `addJob` are mocked everywhere | The graphile-worker check below — the app depends on `jobKey` dedup and named queues (`detection:<userId>`, `tracearr-backfill:<serverId>`, the serial `MAIN_QUEUE`) |
| `lucide-react` | icons never render in vitest | Every imported name must still exist — the icon check below |
| `prisma` | integration tests use it for real | `prepare-test-db.sh` refusing on a `prisma` bump but not on main means the new Prisma diffs the schema differently — and production's `db push` would act on that at boot |
| `next`, `react` | page rendering is not unit-tested | Lean on Browser E2E (every authenticated page renders in `navigation.spec`) |

Useful one-offs (run from the repo root so package resolution works; delete the file after):

```bash
# every lucide icon name the app imports still exists
cat > .icon-check.mjs <<'EOF'
import { readFileSync } from "fs"; import { execSync } from "child_process";
import * as icons from "lucide-react";
const files = execSync('grep -rl "lucide-react" --include=*.tsx --include=*.ts src', {encoding:"utf8"}).trim().split("\n");
const names = new Set();
for (const f of files)
  // `import type { … }` is skipped wholesale and an inline `type X` specifier is dropped:
  // both are erased at compile time, so a runtime `in` check always calls them missing.
  for (const m of readFileSync(f,"utf8").matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']lucide-react["']/g)) {
    if (m[1]) continue;
    for (let n of m[2].split(",")) {
      n = n.trim().split(/\s+as\s+/)[0].trim();
      if (n && !/^type\s/.test(n)) names.add(n);
    }
  }
const missing = [...names].filter(n => !(n in icons));
console.log(missing.length ? "MISSING: " + missing.join(", ") : `ok — ${names.size} icon names resolve`);
EOF
node .icon-check.mjs; rm .icon-check.mjs
```

A clean run prints `ok — N icon names resolve`. If it ever prints `MISSING: LucideIcon` the
type-import filtering has regressed, not the dependency — type-only exports do not exist at
runtime, and `tsc --noEmit` is what covers them.

```bash
# graphile-worker: the real crontab parser, and jobKey dedup on a named queue.
# Needs librariarr_test (run prepare-test-db.sh first); cleans up after itself.
cat > .gw-check.mjs <<'EOF'
import { readFileSync } from "fs";
import { parseCrontab, makeWorkerUtils } from "graphile-worker";
// The app's real CRONTAB, read from source with its TASK_* constants substituted, so this
// check cannot drift from worker.ts the way a hand-copied crontab would.
const consts = Object.fromEntries([...readFileSync("src/lib/jobs/constants.ts", "utf8")
  .matchAll(/export const (TASK_\w+) = "([^"]+)"/g)].map(m => [m[1], m[2]]));
const raw = readFileSync("src/lib/jobs/worker.ts", "utf8").match(/const CRONTAB = `([^`]*)`/)[1];
const crontab = raw.replace(/\$\{(\w+)\}/g, (_, k) => consts[k] ?? `UNRESOLVED_${k}`).trim();
if (crontab.includes("UNRESOLVED_")) throw new Error(`unresolved task constant in CRONTAB:\n${crontab}`);
const lines = crontab.split("\n").filter(Boolean).length;
console.log(`crontab: ${parseCrontab(crontab).length} of ${lines} lines parsed`);
const utils = await makeWorkerUtils({ connectionString: "postgresql://librariarr:librariarr@localhost:5432/librariarr_test" });
await utils.migrate();
for (let i = 0; i < 3; i++) await utils.addJob("noop", { i }, { jobKey: "dedup-check", queueName: "main" });
const { rows } = await utils.withPgClient(c => c.query("select count(*)::int n from graphile_worker.jobs where key = 'dedup-check'"));
console.log(`jobKey: 3 enqueues -> ${rows[0].n} job (want 1)`);
await utils.withPgClient(c => c.query("select graphile_worker.remove_job('dedup-check')"));
await utils.release();
EOF
node .gw-check.mjs; rm .gw-check.mjs
```


## Ruleset, and how branches move under you

- Merging requires **6 required checks on a branch that is up to date with main**, so every
  merge invalidates every other PR. Expect one `update_pull_request_branch` + one full CI
  run per PR. A merge attempt on a stale branch fails with
  `405 … 6 of 6 required status checks are expected`.
- **Dependabot force-rebases its own branches** when main moves. Your local branch is
  untouched, but it is now built on a head the remote no longer has, so your push is rejected
  as non-fast-forward. Do not force-push over it (that discards Dependabot's rebase) or pull
  it in (that merges two divergent histories): re-fetch with
  `git fetch origin '+refs/heads/dependabot/*:refs/remotes/origin/dependabot/*'` (the `+` is
  what lets a forced update land), re-check-out the remote head, and re-apply your commit on
  top — often Dependabot's rebase already did the merge you were about to push.
- **Once you push a commit of your own, Dependabot stops managing the branch** — from then
  on every update to main is yours to merge in manually.
- Prefer `update_pull_request_branch` (GitHub merges main in cleanly most of the time). Only
  resolve locally when it returns `merge conflict between base and head`.

## Resolving a lockfile conflict

`pnpm-lock.yaml` conflicts are not worth hand-merging. Take main's lockfile and re-apply the
PR's bump **pinned to the exact version the PR proposes**:

```bash
git merge --no-edit origin/main            # resolve package.json by hand: keep BOTH bumps
git checkout origin/main -- pnpm-lock.yaml
pnpm add <pkg>@<exact-version> --lockfile-only       # -D for a devDependency
git add package.json pnpm-lock.yaml && git commit --no-edit   # finishes the merge
node .claude/skills/merge-dep-prs/lock-changes.mjs   # every line must be intentional
```

Pinned, because `pnpm install --lockfile-only` re-resolves the range to the **newest**
matching release: a PR proposing `zod ^4.5.4` relocks to 4.6.5 if that exists, so main gets a
version nobody read the changelog for, under a title naming another. `pnpm add pkg@x.y.z`
locks exactly x.y.z and writes the same `^x.y.z` range Dependabot uses.

**If it fails with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`**, the release is under a day old
and `pnpm-workspace.yaml`'s `minimumReleaseAge: 1440` is holding it — a supply-chain control
the repo set on purpose. Leave that PR for a later pass. Do **not** follow the error's own
suggestion of adding the package to `minimumReleaseAgeExclude`.

`lock-changes.mjs` lists every direct dependency whose resolved version differs from main,
across both lockfiles. A relock can move more than the PR's package — a peer requirement drags
its peer along — and each of those moves needs naming in the squash title or body. It is how
the Starlight 0.42 merge was found to have also moved astro 7.2.9 → 7.3.1 unannounced.

**`docs/` is npm, not pnpm** (`docs/package-lock.json`, built by `withastro/action`). Same
rule — pinned — and relock with the **same npm major that wrote main's lockfile**, because an
older npm silently strips the `libc` field from optional platform packages. The subshell
matters: it keeps you at the repo root for the commands after it.

```bash
git checkout origin/main -- docs/package-lock.json
(cd docs && npx -y npm@12 install <pkg>@<exact-version> --package-lock-only && npm ci && npm run build)
node .claude/skills/merge-dep-prs/lock-changes.mjs   # also flags a libc strip
```

`lock-changes.mjs` reports a strip as "N package(s) lost their libc field" and exits 1. Do not
check for it by counting `libc` lines in the diff: a correct relock that adds or removes a
platform package changes those lines too (the clean Starlight relock changed eight).

That build is the validation for a docs PR: every page builds, and the MDX components still
render — grep `docs/dist/` for `sl-steps`, `starlight-aside` and `expressive-code`, since a
Starlight or Astro major can drop a component and still exit 0.

## Titles lie — fix them before squashing

Dependabot rebases a PR onto a newer version without retitling, and **the squash title
becomes the commit subject release-please reads for the changelog**. Always compare the
title against `lock-changes.mjs`' output on the up-to-date branch — not a `git diff` against
main from a stale branch, which shows main's newer bumps as if this PR reverted them — and
correct it with `update_pull_request` before merging (seen: a PR titled 1.38.0 that bumped to 1.39.0, and
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
