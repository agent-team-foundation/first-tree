#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

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
SOURCE_DIR=""
if [[ -n "$REPO_ROOT" ]]; then
  SOURCE_DIR="$REPO_ROOT/skills/first-tree-cli-framework"
fi

if [[ -z "$REPO_ROOT" || "$SKILL_DIR" != "$SOURCE_DIR" ]]; then
  echo "Run this script from the source-of-truth skill at skills/first-tree-cli-framework inside a live first-tree checkout." >&2
  exit 1
fi

for mirror_root in "$REPO_ROOT/.agents/skills/first-tree-cli-framework" "$REPO_ROOT/.claude/skills/first-tree-cli-framework"; do
  mkdir -p "$(dirname "$mirror_root")"
  rsync -a --delete "$SOURCE_DIR/" "$mirror_root/"
done

echo "Exported mirrors to .agents/skills/first-tree-cli-framework and .claude/skills/first-tree-cli-framework"
