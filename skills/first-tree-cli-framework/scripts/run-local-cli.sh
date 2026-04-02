#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SKILL_DIR}/../.." && pwd)"
INSTALL_GUIDE="${SKILL_DIR}/references/portable-quickstart.md"

if [[ -f "${REPO_ROOT}/package.json" ]] && grep -q '"name": "first-tree"' "${REPO_ROOT}/package.json"; then
  cd "${REPO_ROOT}"
  pnpm build >/dev/null
  exec node dist/cli.js "$@"
fi

if command -v context-tree >/dev/null 2>&1; then
  exec context-tree "$@"
fi

echo "Could not find a live first-tree checkout or an installed 'context-tree' binary." >&2
echo "Read the portable install guide at: ${INSTALL_GUIDE}" >&2
exit 1
