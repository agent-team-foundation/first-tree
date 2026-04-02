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

compare_file() {
  local left="$1"
  local right="$2"
  if [[ ! -f "$left" ]]; then
    echo "Missing file: $left" >&2
    return 1
  fi
  if [[ ! -f "$right" ]]; then
    echo "Missing file: $right" >&2
    return 1
  fi
  diff -u "$left" "$right"
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

SNAPSHOT_DIR="$SOURCE_DIR/references/repo-snapshot"

compare_file "$REPO_ROOT/AGENTS.md" "$SNAPSHOT_DIR/AGENTS.md"
compare_file "$REPO_ROOT/README.md" "$SNAPSHOT_DIR/README.md"
compare_file "$REPO_ROOT/package.json" "$SNAPSHOT_DIR/package.json"
compare_file "$REPO_ROOT/evals/helpers/case-loader.ts" "$SNAPSHOT_DIR/evals/helpers/case-loader.ts"
compare_file "$REPO_ROOT/evals/tests/eval-helpers.test.ts" "$SNAPSHOT_DIR/evals/tests/eval-helpers.test.ts"
compare_dir "$REPO_ROOT/.context-tree" "$SNAPSHOT_DIR/.context-tree"
compare_dir "$REPO_ROOT/docs" "$SNAPSHOT_DIR/docs"
compare_dir "$REPO_ROOT/src" "$SNAPSHOT_DIR/src"
compare_dir "$REPO_ROOT/tests" "$SNAPSHOT_DIR/tests"

compare_dir "$SOURCE_DIR" "$REPO_ROOT/.agents/skills/first-tree-cli-framework"
compare_dir "$SOURCE_DIR" "$REPO_ROOT/.claude/skills/first-tree-cli-framework"

echo "Skill source, mirrors, and bundled snapshot are in sync."
