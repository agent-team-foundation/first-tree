#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

find_repo_root() {
  local dir="$SKILL_DIR"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/package.json" ]] && grep -q '"name": "first-tree-monorepo"' "$dir/package.json"; then
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
  SOURCE_DIR="$REPO_ROOT/skills/first-tree"
fi

if [[ -z "$REPO_ROOT" || "$SKILL_DIR" != "$SOURCE_DIR" ]]; then
  echo "Run this script from the source-of-truth skill at skills/first-tree inside a live first-tree checkout." >&2
  exit 1
fi

errors=0

for mirror in "$REPO_ROOT/.agents/skills/first-tree" "$REPO_ROOT/.claude/skills/first-tree"; do
  if [[ ! -L "$mirror" ]]; then
    echo "Expected symlink at $mirror but it is not a symlink." >&2
    errors=$((errors + 1))
    continue
  fi
  target="$(readlink "$mirror")"
  if [[ "$target" != "../../skills/first-tree" ]]; then
    echo "Symlink $mirror points to '$target' instead of '../../skills/first-tree'." >&2
    errors=$((errors + 1))
  fi
done

if [[ $errors -gt 0 ]]; then
  exit 1
fi

echo "Skill symlinks are correct."
