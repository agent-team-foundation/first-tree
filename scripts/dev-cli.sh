#!/usr/bin/env bash
# scripts/dev-cli.sh — run the in-tree CLI against an isolated home so it
# cannot collide with a production `first-tree-hub` install on the same
# machine. Pairs with the home-derived service-suffix logic in
# packages/command/src/core/service-install.ts: a non-default
# FIRST_TREE_HUB_HOME yields a non-default systemd unit / launchd label,
# so prod and dev background services coexist as separate units.
#
# Default isolated home is `~/.first-tree/hub-dev` → service unit
# `first-tree-hub-client-dev.service` (systemd) /
# `dev.first-tree-hub.client.dev` (launchd). Override with
# FIRST_TREE_HUB_DEV_HOME if you need multiple parallel dev installs
# (e.g. one per branch).
#
# Usage:
#   scripts/dev-cli.sh client status
#   scripts/dev-cli.sh client connect <url> --token <t>
#   scripts/dev-cli.sh update --check
#   scripts/dev-cli.sh --rebuild client restart   # rebuild dist first
#
# See docs/local-dev-isolation.md for the full picture.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# package.json `bin` points at dist/cli/index.mjs — that's the CLI entry that
# actually calls `program.parse()`. dist/index.mjs is the library `exports`
# entry and only re-exports types/functions, so node-running it exits 0 with
# zero output.
DIST="$REPO_ROOT/packages/command/dist/cli/index.mjs"

if [[ "${1:-}" == "--rebuild" ]]; then
  shift
  pnpm --filter @agent-team-foundation/first-tree-hub build
elif [[ ! -f "$DIST" ]]; then
  echo "[dev-cli] dist not built — running build (one-time)..." >&2
  pnpm --filter @agent-team-foundation/first-tree-hub build
fi

export FIRST_TREE_HUB_HOME="${FIRST_TREE_HUB_DEV_HOME:-$HOME/.first-tree/hub-dev}"
exec node "$DIST" "$@"
