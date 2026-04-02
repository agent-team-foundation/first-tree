#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SKILL_DIR}/../.." && pwd)"
SNAPSHOT_DIR="${SKILL_DIR}/references/repo-snapshot"

if [[ ! -f "${REPO_ROOT}/package.json" ]] || ! grep -q '"name": "first-tree"' "${REPO_ROOT}/package.json"; then
  echo "This script must be run from a skills/first-tree-cli-framework folder inside a live first-tree checkout." >&2
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

echo "Refreshed portable snapshot at ${SNAPSHOT_DIR}"
