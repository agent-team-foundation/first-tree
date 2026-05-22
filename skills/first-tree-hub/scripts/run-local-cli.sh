#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALL_GUIDE="${SKILL_DIR}/references/portable-quickstart.md"

find_repo_root() {
  local dir="$SKILL_DIR"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/package.json" ]] && grep -q '"name": "first-tree-hub"' "$dir/package.json"; then
      printf '%s\n' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

REPO_ROOT="$(find_repo_root || true)"

if [[ -n "$REPO_ROOT" && "$SKILL_DIR" == "$REPO_ROOT/skills/first-tree-hub" ]]; then
  (
    cd "$REPO_ROOT"
    pnpm --filter @agent-team-foundation/first-tree-hub build >/dev/null
    node ./apps/cli/dist/cli/index.mjs "$@"
  )
  exit 0
fi

if command -v first-tree-hub >/dev/null 2>&1; then
  exec first-tree-hub "$@"
fi

echo "No live first-tree-hub checkout or installed first-tree-hub binary found." >&2
echo "See ${INSTALL_GUIDE} for repo and portable install instructions." >&2
exit 1
