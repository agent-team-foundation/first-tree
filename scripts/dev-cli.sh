#!/usr/bin/env bash
# scripts/dev-cli.sh — run the in-tree CLI against an isolated home so it
# cannot collide with a production `first-tree` install on the same
# machine. Pairs with the home-derived service-suffix logic in
# apps/cli/src/core/service-install.ts: a non-default
# FIRST_TREE_HOME yields a non-default systemd unit / launchd label,
# so prod and dev background services coexist as separate units.
#
# Default isolated home is `~/.first-tree/hub-dev` → service unit
# `first-tree-client-dev.service` (systemd) /
# `dev.first-tree.client.dev` (launchd). Override with
# FIRST_TREE_DEV_HOME if you need multiple parallel dev installs
# (e.g. one per branch).
#
# Usage:
#   scripts/dev-cli.sh client status
#   scripts/dev-cli.sh connect <connect-token>
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
DIST="$REPO_ROOT/apps/cli/dist/cli/index.mjs"

if [[ "${1:-}" == "--rebuild" ]]; then
  shift
  pnpm --filter first-tree build
elif [[ ! -f "$DIST" ]]; then
  echo "[dev-cli] dist not built — running build (one-time)..." >&2
  pnpm --filter first-tree build
fi

export FIRST_TREE_HOME="${FIRST_TREE_DEV_HOME:-$HOME/.first-tree/hub-dev}"

# Prepend the in-tree CLI wrapper to PATH so any process started directly
# from this shell (e.g. ad-hoc `dev-cli.sh chat send ...`) resolves
# `first-tree` to the local dist instead of /usr/local/bin (the global
# staging CLI). Note: when the client runs as a systemd/launchd service,
# this export is IGNORED by the service manager — the unit/plist holds the
# authoritative PATH. See ensure_dev_bin_in_service_path below.
export PATH="$REPO_ROOT/scripts/dev-bin:$PATH"

# systemd ignores shell-exported PATH and uses the `Environment=PATH=...`
# in the unit file as the authoritative PATH for the service AND every
# descendant process (agent runtime CLAUDE sessions). service-install
# hardcodes that to `/usr/local/bin:/usr/bin:/bin`, so agent runtime
# children resolve `first-tree` to /usr/local/bin/first-tree —
# i.e. the globally-installed staging CLI — and call endpoints the local
# dev server no longer exposes (HTTP 404).
#
# This function patches the dev client's unit file in place to prepend
# scripts/dev-bin to its PATH and restarts the unit if it is active.
# Idempotent: once patched, subsequent runs are no-ops.
# Scoped: only touches units whose FIRST_TREE_HOME matches this dev
# home, so the user's separate staging-client unit is left alone.
ensure_dev_bin_in_service_path() {
  case "$(uname -s)" in
    Linux) ;;
    Darwin)
      # launchd uses ~/Library/LaunchAgents/*.plist; patch via PlistBuddy
      # if/when service-install starts emitting a dev plist on macOS.
      return 0 ;;
    *) return 0 ;;
  esac
  local units_dir="$HOME/.config/systemd/user"
  [[ -d "$units_dir" ]] || return 0
  local dev_bin="$REPO_ROOT/scripts/dev-bin"
  local home_marker="Environment=FIRST_TREE_HOME=${FIRST_TREE_HOME}"
  shopt -s nullglob
  local unit
  for unit in "$units_dir"/first-tree-client*.service; do
    grep -qxF "$home_marker" "$unit" || continue
    grep -q "^Environment=PATH=[^[:space:]]*${dev_bin}" "$unit" && continue
    sed -i.bak "s|^Environment=PATH=|Environment=PATH=${dev_bin}:|" "$unit"
    rm -f "${unit}.bak"
    local name
    name="$(basename "$unit")"
    echo "[dev-cli] patched ${name}: prepended scripts/dev-bin to Environment=PATH" >&2
    systemctl --user daemon-reload 2>/dev/null || true
    if systemctl --user is-active --quiet "$name"; then
      systemctl --user restart "$name" 2>/dev/null || true
      echo "[dev-cli] restarted ${name} so its children inherit the new PATH" >&2
    fi
  done
  shopt -u nullglob
}
ensure_dev_bin_in_service_path

exec node "$DIST" "$@"
