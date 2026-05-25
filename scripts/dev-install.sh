#!/usr/bin/env bash
# scripts/dev-install.sh — install the in-tree CLI as `first-tree-dev` on PATH.
#
# Source-tree CHANNEL is "dev" (set in apps/cli/src/build-info.ts), so the
# built binary already knows its identity: bin name `first-tree-dev` (alias
# `ftd`), default home `~/.first-tree-dev/`, default server
# http://127.0.0.1:8000, service unit `first-tree-dev.service` / launchd
# label `first-tree-dev`. Matches the staging / prod operational model
# (same verbs, separate service unit) — only difference is install method
# (symlink from this repo, not npm).
#
# Usage:
#   ./scripts/dev-install.sh                    # build + (re)link
#   first-tree-dev login <token>                # connect to local server
#   first-tree-dev daemon status                # same verbs as staging/prod
#
# Re-run this script after editing any source file to rebuild dist.
#
# Replaces scripts/dev-cli.sh (the FIRST_TREE_HOME wrapper). dev-install
# does NOT export FIRST_TREE_HOME — the built CLI handles channel
# resolution itself via apps/cli/src/core/channel-env.ts.

set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DIST="$REPO/apps/cli/dist/cli/index.mjs"
BIN_DIR="${HOME}/.local/bin"

# Auto-migrate the legacy dev home from the pre-multi-env layout
# (scripts/dev-cli.sh used ~/.first-tree/hub-dev). One-shot mv — never
# copies, so the data structure is preserved bit-for-bit.
LEGACY_DEV_HOME="${HOME}/.first-tree/hub-dev"
NEW_DEV_HOME="${HOME}/.first-tree-dev"
if [[ -d "$LEGACY_DEV_HOME" && ! -d "$NEW_DEV_HOME" ]]; then
  echo "[dev-install] migrating legacy dev home: $LEGACY_DEV_HOME → $NEW_DEV_HOME"
  mv "$LEGACY_DEV_HOME" "$NEW_DEV_HOME"
fi

# Build dist (always — covers source edits since the last run). Go
# through turbo so workspace dependencies (`@first-tree/shared` in
# particular) build first per `turbo.json`'s `dependsOn: ["^build"]`.
# A plain `pnpm --filter first-tree-dev build` skips dependency
# resolution and fails with missing exports from a stale `dist/`.
pnpm exec turbo run build --filter=first-tree-dev

# Symlink to user-local PATH. Both names point at the same dist so they
# stay in sync without a second link step.
mkdir -p "$BIN_DIR"
ln -sf "$DIST" "$BIN_DIR/first-tree-dev"
ln -sf "$DIST" "$BIN_DIR/ftd"

echo "[dev-install] installed:"
echo "  $BIN_DIR/first-tree-dev → $DIST"
echo "  $BIN_DIR/ftd            → $DIST"
echo
echo "Next:"
echo "  1. Make sure $BIN_DIR is on \$PATH"
echo "  2. Start your local hub server on http://127.0.0.1:8000"
echo "  3. first-tree-dev login <token>      # token from http://127.0.0.1:8000/clients"
