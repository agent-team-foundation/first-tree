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

for mirror_root in "$REPO_ROOT/.agents/skills/first-tree-hub-cli" "$REPO_ROOT/.claude/skills/first-tree-hub-cli"; do
  mkdir -p "$(dirname "$mirror_root")"
  rsync -a --delete "$SOURCE_DIR/" "$mirror_root/"
done

echo "Exported mirrors to .agents/skills/first-tree-hub-cli and .claude/skills/first-tree-hub-cli"
