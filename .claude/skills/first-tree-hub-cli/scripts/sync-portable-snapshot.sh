#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SNAPSHOT_DIR="${SKILL_DIR}/references/repo-snapshot"
FINGERPRINT_SCRIPT="${SCRIPT_DIR}/snapshot_fingerprint.py"

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

rm -rf "${SNAPSHOT_DIR}"
mkdir -p \
  "${SNAPSHOT_DIR}/docs" \
  "${SNAPSHOT_DIR}/packages/command/scripts" \
  "${SNAPSHOT_DIR}/packages/shared/src" \
  "${SNAPSHOT_DIR}/packages/client/src" \
  "${SNAPSHOT_DIR}/packages/server/src/services"

cp "${REPO_ROOT}/AGENTS.md" "${REPO_ROOT}/README.md" "${REPO_ROOT}/package.json" "${SNAPSHOT_DIR}/"
cp -R "${REPO_ROOT}/docs/." "${SNAPSHOT_DIR}/docs/"

mkdir -p "${SNAPSHOT_DIR}/packages/command" "${SNAPSHOT_DIR}/packages/shared" "${SNAPSHOT_DIR}/packages/client" "${SNAPSHOT_DIR}/packages/server"
cp "${REPO_ROOT}/packages/command/package.json" "${SNAPSHOT_DIR}/packages/command/"
cp "${REPO_ROOT}/packages/command/scripts/embed-assets.mjs" "${SNAPSHOT_DIR}/packages/command/scripts/"
cp -R "${REPO_ROOT}/packages/command/src" "${SNAPSHOT_DIR}/packages/command/"

cp "${REPO_ROOT}/packages/shared/package.json" "${SNAPSHOT_DIR}/packages/shared/"
cp -R "${REPO_ROOT}/packages/shared/src/config" "${SNAPSHOT_DIR}/packages/shared/src/"

cp "${REPO_ROOT}/packages/client/package.json" "${SNAPSHOT_DIR}/packages/client/"
cp "${REPO_ROOT}/packages/client/src/sdk.ts" "${SNAPSHOT_DIR}/packages/client/src/"
cp -R "${REPO_ROOT}/packages/client/src/runtime" "${SNAPSHOT_DIR}/packages/client/src/"

cp "${REPO_ROOT}/packages/server/package.json" "${SNAPSHOT_DIR}/packages/server/"
cp "${REPO_ROOT}/packages/server/src/app.ts" "${SNAPSHOT_DIR}/packages/server/src/"
cp "${REPO_ROOT}/packages/server/src/services/inbox.ts" "${SNAPSHOT_DIR}/packages/server/src/services/"
cp "${REPO_ROOT}/packages/server/src/services/context-tree-graphql.ts" "${SNAPSHOT_DIR}/packages/server/src/services/"

CURRENT_COMMIT="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
CURRENT_FINGERPRINT="$(python3 "${FINGERPRINT_SCRIPT}" --root "${REPO_ROOT}")"
perl -0pi -e 's/snapshot base commit when this portable copy was refreshed: `[^`]+`/snapshot base commit when this portable copy was refreshed: `'"${CURRENT_COMMIT}"'`/g' "${SKILL_DIR}/references/portable-quickstart.md"
perl -0pi -e 's/snapshot content fingerprint: `[^`]+`/snapshot content fingerprint: `'"${CURRENT_FINGERPRINT}"'`/g' "${SKILL_DIR}/references/portable-quickstart.md"

echo "Refreshed portable snapshot at ${SNAPSHOT_DIR}"
