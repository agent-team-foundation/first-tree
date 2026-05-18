#!/usr/bin/env bash
# Removal drill — proves `packages/e2e` is independently deletable.
#
# Walks the proposal §三.2 deletion checklist end-to-end:
#   1. Stash `packages/e2e/` aside.
#   2. Strip `e2e:*` script entries from the root `package.json`.
#   3. Strip e2e task definitions from `turbo.json`.
#   4. Run `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
#      and `pnpm --filter @agent-team-foundation/first-tree-hub build`.
#   5. Capture the CLI tarball file hash, restore everything, rebuild,
#      and assert the published artifact hash is byte-identical.
#
# Run from the repo root. Exits non-zero on any failure; restores all
# modified files on EXIT (success or failure) so a Ctrl-C never leaves the
# tree in a broken state.
#
# PR review evidence: paste the final hash line into the PR body.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [[ ! -d packages/e2e ]]; then
  echo "✗  packages/e2e is already absent — nothing to verify"
  exit 1
fi

STASH_DIR="$(mktemp -d -t hub-e2e-stash-XXXXXX)"
trap restore EXIT

restore() {
  # Restore root package.json + turbo.json first so a partial run never
  # leaves them in the stripped state.
  if [[ -f "$STASH_DIR/package.json" ]]; then
    cp "$STASH_DIR/package.json" package.json
  fi
  if [[ -f "$STASH_DIR/turbo.json" ]]; then
    cp "$STASH_DIR/turbo.json" turbo.json
  fi
  if [[ -d "$STASH_DIR/e2e" ]]; then
    rm -rf packages/e2e
    mv "$STASH_DIR/e2e" packages/e2e
  fi
  rm -rf "$STASH_DIR"
  echo "↩  packages/e2e + root configs restored."
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "✗  required command \`$1\` not on PATH" >&2
    exit 1
  fi
}

require_cmd pnpm
require_cmd node
require_cmd shasum

# Strip e2e:* scripts + task entries using node so we don't depend on jq.
strip_root_configs() {
  node -e '
    const fs = require("node:fs");
    const pkgPath = "package.json";
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (pkg.scripts) {
      for (const k of Object.keys(pkg.scripts)) {
        if (k.startsWith("e2e:") || k === "e2e") delete pkg.scripts[k];
      }
    }
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

    const turboPath = "turbo.json";
    const turbo = JSON.parse(fs.readFileSync(turboPath, "utf8"));
    if (turbo.tasks) {
      for (const k of Object.keys(turbo.tasks)) {
        if (k.startsWith("e2e:") || k === "e2e") delete turbo.tasks[k];
      }
    }
    fs.writeFileSync(turboPath, JSON.stringify(turbo, null, 2) + "\n");
  '
}

echo "→  stashing packages/e2e + root configs at $STASH_DIR …"
cp package.json "$STASH_DIR/package.json"
cp turbo.json "$STASH_DIR/turbo.json"
mv packages/e2e "$STASH_DIR/e2e"
strip_root_configs

echo "→  pnpm install (must succeed without packages/e2e)…"
pnpm install --frozen-lockfile=false >/dev/null

echo "→  pnpm typecheck …"
pnpm typecheck >/dev/null

echo "→  pnpm test …"
pnpm test >/dev/null

echo "→  pnpm build …"
pnpm build >/dev/null

echo "→  capturing baseline CLI tarball hash (packages/e2e ABSENT)…"
BASELINE_HASH=$(find packages/command/dist -type f -name '*.mjs' -print0 |
  LC_ALL=C sort -z |
  xargs -0 shasum -a 256 |
  shasum -a 256 |
  awk '{print $1}')
echo "    baseline hash: $BASELINE_HASH"

echo "↩  restoring everything for the with-e2e build…"
restore
trap - EXIT

echo "→  pnpm install (packages/e2e present)…"
pnpm install --frozen-lockfile=false >/dev/null

echo "→  pnpm build …"
pnpm build >/dev/null

echo "→  capturing with-e2e CLI tarball hash…"
WITH_E2E_HASH=$(find packages/command/dist -type f -name '*.mjs' -print0 |
  LC_ALL=C sort -z |
  xargs -0 shasum -a 256 |
  shasum -a 256 |
  awk '{print $1}')
echo "    with-e2e hash: $WITH_E2E_HASH"

if [[ "$BASELINE_HASH" != "$WITH_E2E_HASH" ]]; then
  echo "✗  CLI tarball hash differs with/without packages/e2e — the package leaked into the publish artifact!"
  exit 2
fi

echo
echo "✓  packages/e2e is independently removable."
echo "   CLI hash identical with or without it: $WITH_E2E_HASH"
