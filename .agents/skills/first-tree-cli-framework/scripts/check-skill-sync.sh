#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
FINGERPRINT_SCRIPT="${SCRIPT_DIR}/snapshot_fingerprint.py"

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

compare_file "$SOURCE_DIR/references/about.md" "$REPO_ROOT/docs/about.md"
compare_file "$SOURCE_DIR/references/onboarding.md" "$REPO_ROOT/docs/onboarding.md"
compare_file "$SOURCE_DIR/references/principles.md" "$REPO_ROOT/.context-tree/principles.md"
compare_file "$SOURCE_DIR/references/ownership-and-naming.md" "$REPO_ROOT/.context-tree/ownership-and-naming.md"
compare_file "$SOURCE_DIR/assets/framework/VERSION" "$REPO_ROOT/.context-tree/VERSION"
compare_dir "$SOURCE_DIR/assets/framework/templates" "$REPO_ROOT/.context-tree/templates"
compare_dir "$SOURCE_DIR/assets/framework/workflows" "$REPO_ROOT/.context-tree/workflows"
compare_dir "$SOURCE_DIR/assets/framework/prompts" "$REPO_ROOT/.context-tree/prompts"
compare_dir "$SOURCE_DIR/assets/framework/examples" "$REPO_ROOT/.context-tree/examples"
compare_file "$SOURCE_DIR/assets/framework/helpers/generate-codeowners.ts" "$REPO_ROOT/.context-tree/generate-codeowners.ts"
compare_file "$SOURCE_DIR/assets/framework/helpers/run-review.ts" "$REPO_ROOT/.context-tree/run-review.ts"
compare_file "$SOURCE_DIR/assets/framework/helpers/inject-tree-context.sh" "$REPO_ROOT/.context-tree/scripts/inject-tree-context.sh"

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

recorded_commit="$(perl -ne 'print "$1\n" if /snapshot base commit when this portable copy was refreshed: `([0-9a-f]{40})`/' "$SOURCE_DIR/references/portable-quickstart.md")"
recorded_fingerprint="$(perl -ne 'print "$1\n" if /snapshot content fingerprint: `(sha256:[0-9a-f]{64})`/' "$SOURCE_DIR/references/portable-quickstart.md")"
current_commit="$(git -C "$REPO_ROOT" rev-parse HEAD)"
source_fingerprint="$(python3 "${FINGERPRINT_SCRIPT}" --root "${REPO_ROOT}")"
snapshot_fingerprint="$(python3 "${FINGERPRINT_SCRIPT}" --root "${SNAPSHOT_DIR}")"

if [[ -z "$recorded_commit" ]]; then
  echo "Could not find the recorded snapshot base commit in references/portable-quickstart.md." >&2
  exit 1
fi

if [[ -z "$recorded_fingerprint" ]]; then
  echo "Could not find the recorded snapshot content fingerprint in references/portable-quickstart.md." >&2
  exit 1
fi

if git -C "$REPO_ROOT" cat-file -e "${recorded_commit}^{commit}" 2>/dev/null; then
  if ! git -C "$REPO_ROOT" merge-base --is-ancestor "$recorded_commit" "$current_commit"; then
    echo "Portable snapshot base commit $recorded_commit is not an ancestor of repo HEAD $current_commit." >&2
    exit 1
  fi
else
  echo "Portable snapshot base commit $recorded_commit is not present in this checkout; skipping ancestry validation." >&2
fi

if [[ "$recorded_fingerprint" != "$source_fingerprint" ]]; then
  echo "Portable snapshot fingerprint mismatch: quickstart records $recorded_fingerprint but repo source fingerprint is $source_fingerprint." >&2
  exit 1
fi

if [[ "$recorded_fingerprint" != "$snapshot_fingerprint" ]]; then
  echo "Portable snapshot fingerprint mismatch: quickstart records $recorded_fingerprint but bundled snapshot fingerprint is $snapshot_fingerprint." >&2
  exit 1
fi

echo "Skill source, mirrors, and bundled snapshot are in sync."
