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

FRAMEWORK_DIR="$SOURCE_DIR/assets/framework"
LEGACY_DIR="$REPO_ROOT/.context-tree"
DOCS_DIR="$REPO_ROOT/docs"

rm -rf "$LEGACY_DIR"
mkdir -p "$LEGACY_DIR/scripts"

cp "$FRAMEWORK_DIR/VERSION" "$LEGACY_DIR/VERSION"
cp "$SOURCE_DIR/references/principles.md" "$LEGACY_DIR/principles.md"
cp "$SOURCE_DIR/references/ownership-and-naming.md" "$LEGACY_DIR/ownership-and-naming.md"
cp -R "$FRAMEWORK_DIR/templates" "$LEGACY_DIR/"
cp -R "$FRAMEWORK_DIR/workflows" "$LEGACY_DIR/"
cp -R "$FRAMEWORK_DIR/prompts" "$LEGACY_DIR/"
cp -R "$FRAMEWORK_DIR/examples" "$LEGACY_DIR/"
cp "$FRAMEWORK_DIR/helpers/generate-codeowners.ts" "$LEGACY_DIR/generate-codeowners.ts"
cp "$FRAMEWORK_DIR/helpers/run-review.ts" "$LEGACY_DIR/run-review.ts"
cp "$FRAMEWORK_DIR/helpers/inject-tree-context.sh" "$LEGACY_DIR/scripts/inject-tree-context.sh"

mkdir -p "$DOCS_DIR"
cp "$SOURCE_DIR/references/about.md" "$DOCS_DIR/about.md"
cp "$SOURCE_DIR/references/onboarding.md" "$DOCS_DIR/onboarding.md"

echo "Exported runtime assets to .context-tree/ and docs/ mirrors."
