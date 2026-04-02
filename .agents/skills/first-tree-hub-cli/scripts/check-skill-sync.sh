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

compare_dir() {
  local left="$1"
  local right="$2"
  if [[ ! -d "$left" ]]; then
    echo "Missing directory: $left" >&2
    return 1
  fi
  if [[ ! -d "$right" ]]; then
    echo "Missing directory: $right" >&2
    return 1
  fi
  diff -qr "$left" "$right"
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

compare_dir "$SOURCE_DIR" "$REPO_ROOT/.agents/skills/first-tree-hub-cli"
compare_dir "$SOURCE_DIR" "$REPO_ROOT/.claude/skills/first-tree-hub-cli"

echo "Skill source and mirrors are in sync."
