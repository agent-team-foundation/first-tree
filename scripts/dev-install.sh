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
# copies, so the data structure is preserved bit-for-bit. Limited to
# the legacy dev-only path so it cannot touch peer staging / prod
# state (the cli-side auto unit cleanup was removed for that exact
# reason — see service-install.ts docblocks).
LEGACY_DEV_HOME="${HOME}/.first-tree/hub-dev"
NEW_DEV_HOME="${HOME}/.first-tree-dev"
if [[ -d "$LEGACY_DEV_HOME" && ! -d "$NEW_DEV_HOME" ]]; then
  echo "[dev-install] migrating legacy dev home: $LEGACY_DEV_HOME → $NEW_DEV_HOME"
  mv "$LEGACY_DEV_HOME" "$NEW_DEV_HOME"
fi

# Ensure all workspace packages are installed. Idempotent — a no-op
# when the lockfile already matches the on-disk state. Without this,
# any missing `packages/*/node_modules/.bin/tsdown` (e.g. after a
# fresh checkout or a lockfile bump) blows up `pnpm build` with the
# unhelpful "tsdown: not found" error from a transitive workspace
# package, not from us.
pnpm install

# Build everything (full monorepo). Turbo respects per-task
# `dependsOn` so packages build in dependency order, and a warm cache
# makes subsequent runs sub-second. Using `pnpm build` here keeps the
# dev workflow aligned with CI (`.github/workflows/ci.yml` also runs
# `pnpm build`) — any filter-based partial build risks the multi-env
# foot-gun of leaving `packages/shared/dist/` stale.
pnpm build

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
echo "  2. Start your local First Tree server on http://127.0.0.1:8000"
echo "  3. first-tree-dev login <token>      # token from http://127.0.0.1:8000/clients"
