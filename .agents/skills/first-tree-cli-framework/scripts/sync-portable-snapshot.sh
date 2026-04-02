#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SNAPSHOT_DIR="${SKILL_DIR}/references/repo-snapshot"
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

REPO_ROOT="$(find_repo_root || true)"
SOURCE_DIR=""
if [[ -n "$REPO_ROOT" ]]; then
  SOURCE_DIR="$REPO_ROOT/skills/first-tree-cli-framework"
fi

if [[ -z "$REPO_ROOT" || "$SKILL_DIR" != "$SOURCE_DIR" ]]; then
  echo "Run this script from the source-of-truth skill at skills/first-tree-cli-framework inside a live first-tree checkout." >&2
  exit 1
fi

rm -rf "${SNAPSHOT_DIR}"
mkdir -p "${SNAPSHOT_DIR}/docs" "${SNAPSHOT_DIR}/evals/helpers" "${SNAPSHOT_DIR}/evals/tests"

cp "${REPO_ROOT}/AGENTS.md" "${REPO_ROOT}/README.md" "${REPO_ROOT}/package.json" "${SNAPSHOT_DIR}/"
cp -R "${REPO_ROOT}/.context-tree" "${SNAPSHOT_DIR}/"
cp -R "${REPO_ROOT}/docs/." "${SNAPSHOT_DIR}/docs/"
cp -R "${REPO_ROOT}/src" "${SNAPSHOT_DIR}/"
cp -R "${REPO_ROOT}/tests" "${SNAPSHOT_DIR}/"
cp "${REPO_ROOT}/evals/helpers/case-loader.ts" "${SNAPSHOT_DIR}/evals/helpers/"
cp "${REPO_ROOT}/evals/tests/eval-helpers.test.ts" "${SNAPSHOT_DIR}/evals/tests/"

CURRENT_COMMIT="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
CURRENT_FINGERPRINT="$(python3 "${FINGERPRINT_SCRIPT}" --root "${REPO_ROOT}")"
perl -0pi -e 's/snapshot base commit when this portable copy was refreshed: `[^`]+`/snapshot base commit when this portable copy was refreshed: `'"${CURRENT_COMMIT}"'`/g' "${SKILL_DIR}/references/portable-quickstart.md"
perl -0pi -e 's/snapshot content fingerprint: `[^`]+`/snapshot content fingerprint: `'"${CURRENT_FINGERPRINT}"'`/g' "${SKILL_DIR}/references/portable-quickstart.md"

echo "Refreshed portable snapshot at ${SNAPSHOT_DIR}"
