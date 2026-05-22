#!/usr/bin/env bash
set -euo pipefail

# Phase 1B guard: forbid the four legacy CLI strings that were retired during the
# repo-merge command rename. If any of these names ever reappear in the source
# tree (outside the explicit migration exceptions), CI fails and so does the
# local `pnpm check:no-old-names` script.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

forbidden_patterns=(
  "first-tree hub"
  "tree generate-codeowners"
  "tree install-claude-code-hook"
  "tree inject-context"
)

exclude_globs=(
  ":!CHANGELOG.md"
  ":!scripts/check-no-old-names.sh"
  ":!docs/migration/**"
  ":!pnpm-lock.yaml"
  # Migration code legitimately mentions the legacy literal — the v0.4.x →
  # v1.0 hook rewrite logic needs to match the old `tree inject-context`
  # command string to remove it from existing user hook configs.
  ":!apps/cli/src/commands/tree/agent-context-hooks.ts"
)

status=0
for pattern in "${forbidden_patterns[@]}"; do
  if matches="$(git grep -nF -- "$pattern" -- "${exclude_globs[@]}" 2>/dev/null)"; then
    if [[ -n "$matches" ]]; then
      printf 'FAIL: forbidden legacy name "%s" still present:\n%s\n\n' "$pattern" "$matches"
      status=1
    fi
  fi
done

if [[ $status -eq 0 ]]; then
  echo "OK: no forbidden legacy CLI names found."
fi

exit $status
