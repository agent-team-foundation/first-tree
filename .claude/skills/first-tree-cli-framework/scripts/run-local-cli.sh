#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALL_GUIDE="${SKILL_DIR}/references/portable-quickstart.md"

find_repo_root() {
  local dir="$SKILL_DIR"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/package.json" ]] && grep -q '"name": "first-tree"' "$dir/package.json"; then
      printf '%s\n' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

REPO_ROOT="$(find_repo_root || true)"

if [[ -n "${REPO_ROOT}" ]]; then
  cd "$REPO_ROOT"
  pnpm build >/dev/null
  exec node dist/cli.js "$@"
fi

if command -v context-tree >/dev/null 2>&1; then
  exec context-tree "$@"
fi

echo "Could not find a live first-tree checkout or an installed 'context-tree' binary." >&2
echo "Read the portable install guide at: ${INSTALL_GUIDE}" >&2
exit 1
