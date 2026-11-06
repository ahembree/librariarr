#!/usr/bin/env bash
# PreToolUse hook (Bash): before Claude runs a `git commit` whose changes touch
# the docs site or a source its build reads, run the docs build and block the
# commit (exit 2, reason on stderr) when it fails. The docs are otherwise built
# only by CI, so a page that fails to compile reached main once and stopped the
# site deploying.
set -uo pipefail

command=$(jq -r '.tool_input.command // empty')

# Only commits. `git` and `commit` within one command segment (not split by
# a pipe or ;/&), so `git log | grep commit` does not count.
if ! grep -Eq '(^|[;&|[:space:]])git([[:space:]]+-[^[:space:];&|]+)*[[:space:]]+commit([[:space:]]|$)' <<<"$command"; then
  exit 0
fi

repo=${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}
cd "$repo" || exit 0

# Everything the commit could take: staged, unstaged (a `git commit -a` or a
# `git add` earlier in the same command) and untracked files.
changed=$(git status --porcelain --untracked-files=all | sed -E 's/^.. //; s/^.* -> //')

# The docs build reads docs/ plus the OpenAPI and rule-set-library sources
# (docs/package.json's generate:openapi and validate:rulesets).
docs_inputs='^(docs/|scripts/(generate-openapi|validate-rule-set-library|rule-set-library-check)\.ts$|src/lib/api-keys/(openapi|scopes|limits)\.ts$|src/lib/conditions/(fields|operators|types)\.ts$|src/lib/lifecycle/action-types\.ts$|package\.json$)'
if ! grep -Eq "$docs_inputs" <<<"$changed"; then
  exit 0
fi

if [ ! -d docs/node_modules ]; then
  if ! install_log=$(pnpm --prefix docs install --frozen-lockfile 2>&1); then
    echo "Docs dependencies failed to install, so the docs build could not run before this commit:" >&2
    tail -n 20 <<<"$install_log" >&2
    exit 2
  fi
fi

if ! build_log=$(pnpm --prefix docs run build 2>&1); then
  echo "The docs build failed, so this commit was blocked. Fix the docs and commit again." >&2
  grep -E 'ERROR|Error|error|Expected|Location|\.mdx?:' <<<"$build_log" | head -n 20 >&2
  echo "--- last lines of the build ---" >&2
  tail -n 15 <<<"$build_log" >&2
  exit 2
fi

exit 0
