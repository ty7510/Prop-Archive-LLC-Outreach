#!/usr/bin/env bash
# What CI has to check: the changes since the closest commit that already passed CI.
#
# Writes to $GITHUB_OUTPUT:
#   skip=true   this exact code (same tree) already passed CI: nothing to check
#   full=true   no green commit to compare with, or a change that can affect any test
#   base=<sha>  the green commit the diff starts from
#   code=true   a TypeScript file under client/ server/ shared/ scripts/ changed
#   any=true    any file changed
# and the changed file lists to $RUNNER_TEMP/changed-all.txt and changed-code.txt.
set -euo pipefail

out="${GITHUB_OUTPUT:-/dev/stdout}"
all="${RUNNER_TEMP:-/tmp}/changed-all.txt"
code="${RUNNER_TEMP:-/tmp}/changed-code.txt"
: > "$all"
: > "$code"

emit() { echo "$1=$2" >> "$out"; }

# Commits that passed this workflow (any branch, newest first), from the Actions API.
green=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow ci.yml --status success \
  --limit 300 --json headSha -q '.[].headSha' 2>/dev/null | awk '!seen[$0]++' || true)

head_tree=$(git rev-parse 'HEAD^{tree}')
base=""
best=""
for sha in $green; do
  git cat-file -e "$sha^{commit}" 2>/dev/null || continue
  if [ "$(git rev-parse "$sha^{tree}")" = "$head_tree" ]; then
    echo "Commit $sha has exactly this code and already passed CI: nothing new to check"
    emit skip true
    exit 0
  fi
  if git merge-base --is-ancestor "$sha" HEAD; then
    n=$(git rev-list --count "$sha..HEAD")
    if [ -z "$best" ] || [ "$n" -lt "$best" ]; then
      best=$n
      base=$sha
    fi
  fi
done

emit skip false
if [ -z "$base" ]; then
  echo "No earlier green commit in this history: full run"
  emit full true
  emit code true
  emit any true
  exit 0
fi

git diff --name-only --diff-filter=ACMRD "$base" HEAD > "$all"
grep -E '^(client|server|shared|scripts)/.+\.(ts|tsx)$' "$all" | while read -r f; do
  [ -f "$f" ] && echo "$f"
done > "$code" || true

# Plain source and docs are safe to check file by file: vitest follows imports from a changed
# file to the tests that use it. Anything else (dependencies, configs, migrations, seed data,
# content, the database and test setup, CI itself) can change tests that never import it.
full=false
if grep -qvE '^((client|server|shared)/.+\.(ts|tsx|css)|docs/.+|README\.md)$' "$all" ||
  grep -qE '^server/db/' "$all"; then
  full=true
fi

emit base "$base"
emit full "$full"
emit code "$([ -s "$code" ] && echo true || echo false)"
emit any "$([ -s "$all" ] && echo true || echo false)"
echo "Last green commit: $base ($best commits back)  full run: $full"
echo "Changed since then:"
cat "$all"
