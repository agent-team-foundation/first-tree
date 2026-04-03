#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

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
SOURCE_DIR=""
if [[ -n "$REPO_ROOT" ]]; then
  SOURCE_DIR="$REPO_ROOT/skills/first-tree-hub-cli"
fi

if [[ -z "$REPO_ROOT" || "$SKILL_DIR" != "$SOURCE_DIR" ]]; then
  echo "Run this script from the source-of-truth skill at skills/first-tree-hub-cli inside a live first-tree-hub checkout." >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

mkdir -p "$tmpdir/skills/first-tree-hub-cli"
rsync -a "$SOURCE_DIR/" "$tmpdir/skills/first-tree-hub-cli/"

cd "$tmpdir/skills/first-tree-hub-cli"

set +e
PATH="/usr/bin:/bin" ./scripts/run-local-cli.sh --help >stdout.txt 2>stderr.txt
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo "Expected portable runner to fail outside a repo when no installed first-tree-hub binary is available." >&2
  exit 1
fi

if ! grep -q "portable-quickstart.md" stderr.txt; then
  echo "Portable runner did not point to portable-quickstart.md." >&2
  cat stderr.txt >&2
  exit 1
fi

echo "Portable smoke test passed."
