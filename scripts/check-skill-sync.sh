#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ ! -f "$REPO_ROOT/package.json" ]] || ! grep -q '"name": "first-tree"' "$REPO_ROOT/package.json"; then
  echo "check-skill-sync.sh must run inside a first-tree checkout." >&2
  exit 1
fi

SKILL_DIR="$REPO_ROOT/skills/first-tree"
ASSETS_DIR="$REPO_ROOT/assets/tree"
ENGINE_DIR="$REPO_ROOT/src/products/tree/engine"
TESTS_DIR="$REPO_ROOT/tests"

require_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "Missing file: $path" >&2
    exit 1
  fi
}

require_symlink_target() {
  local path="$1"
  local expected="$2"
  if [[ ! -L "$path" ]]; then
    echo "Missing symlink: $path" >&2
    exit 1
  fi

  local actual
  actual="$(readlink "$path")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Unexpected symlink target for $path: expected $expected, got $actual" >&2
    exit 1
  fi
}

# Lightweight skill payload: SKILL.md, VERSION, and user-facing references only.
require_file "$SKILL_DIR/SKILL.md"
require_file "$SKILL_DIR/VERSION"
require_file "$SKILL_DIR/references/whitepaper.md"
require_file "$SKILL_DIR/references/onboarding.md"
require_file "$SKILL_DIR/references/source-workspace-installation.md"
require_file "$SKILL_DIR/references/principles.md"
require_file "$SKILL_DIR/references/ownership-and-naming.md"
require_file "$SKILL_DIR/references/upgrade-contract.md"

# Skill payload must NOT contain engine, assets, tests, scripts, or agents.
for forbidden in engine assets tests scripts agents; do
  if [[ -e "$SKILL_DIR/$forbidden" ]]; then
    echo "Skill payload should not contain $forbidden/ — it belongs at the repo root." >&2
    exit 1
  fi
done

# Source-repo maintainer docs live in top-level docs/.
require_file "$REPO_ROOT/docs/source-map.md"
require_file "$REPO_ROOT/docs/design-sync.md"
require_file "$REPO_ROOT/docs/maintainer-architecture.md"
require_file "$REPO_ROOT/docs/maintainer-thin-cli.md"
require_file "$REPO_ROOT/docs/maintainer-build-and-distribution.md"
require_file "$REPO_ROOT/docs/maintainer-testing.md"

# Engine lives under src/products/tree/engine.
require_file "$ENGINE_DIR/init.ts"
require_file "$ENGINE_DIR/member-seeding.ts"
require_file "$ENGINE_DIR/onboarding.ts"
require_file "$ENGINE_DIR/repo.ts"
require_file "$ENGINE_DIR/upgrade.ts"
require_file "$ENGINE_DIR/verify.ts"
require_file "$ENGINE_DIR/commands/help.ts"
require_file "$ENGINE_DIR/commands/init.ts"
require_file "$ENGINE_DIR/commands/upgrade.ts"
require_file "$ENGINE_DIR/commands/verify.ts"
require_file "$ENGINE_DIR/rules/index.ts"
require_file "$ENGINE_DIR/runtime/asset-loader.ts"
require_file "$ENGINE_DIR/runtime/installer.ts"
require_file "$ENGINE_DIR/runtime/source-integration.ts"
require_file "$ENGINE_DIR/runtime/upgrader.ts"
require_file "$ENGINE_DIR/runtime/adapters.ts"
require_file "$ENGINE_DIR/validators/members.ts"
require_file "$ENGINE_DIR/validators/nodes.ts"

# Tree product has its own VERSION + cli entrypoint; breeze is a stub.
require_file "$REPO_ROOT/src/products/tree/VERSION"
require_file "$REPO_ROOT/src/products/tree/cli.ts"
require_file "$REPO_ROOT/src/products/breeze/VERSION"
require_file "$REPO_ROOT/src/products/breeze/cli.ts"

# Tests live under tests/.
require_file "$TESTS_DIR/init.test.ts"
require_file "$TESTS_DIR/member-seeding.test.ts"
require_file "$TESTS_DIR/verify.test.ts"
require_file "$TESTS_DIR/skill-artifacts.test.ts"

# Assets live under assets/tree.
require_file "$ASSETS_DIR/manifest.json"
require_file "$ASSETS_DIR/VERSION"
require_file "$ASSETS_DIR/prompts/pr-review.md"
require_file "$ASSETS_DIR/templates/root-node.md.template"
require_file "$ASSETS_DIR/templates/agents.md.template"
require_file "$ASSETS_DIR/templates/members-domain.md.template"
require_file "$ASSETS_DIR/templates/member-node.md.template"
require_file "$ASSETS_DIR/workflows/validate.yml"
require_file "$ASSETS_DIR/workflows/pr-review.yml"
require_file "$ASSETS_DIR/workflows/codeowners.yml"
require_file "$ASSETS_DIR/examples/claude-code/README.md"
require_file "$ASSETS_DIR/examples/claude-code/settings.json"
require_file "$ASSETS_DIR/helpers/generate-codeowners.ts"
require_file "$ASSETS_DIR/helpers/run-review.ts"
require_file "$ASSETS_DIR/helpers/summarize-progress.js"

require_file "$REPO_ROOT/evals/first-tree-eval.test.ts"
require_file "$REPO_ROOT/evals/README.md"
require_file "$REPO_ROOT/evals/helpers/case-loader.ts"
require_file "$REPO_ROOT/evals/scripts/tree-manager.ts"
require_file "$REPO_ROOT/evals/tests/eval-helpers.test.ts"
require_symlink_target "$REPO_ROOT/.agents/skills/first-tree" "../../skills/first-tree"
require_symlink_target "$REPO_ROOT/.claude/skills/first-tree" "../../.agents/skills/first-tree"

# Check for legacy artifacts that should not be committed. The skill payload
# under skills/first-tree/ must contain only SKILL.md, VERSION, and references/;
# never engine code, test code, scripts, or build artefacts.
for legacy_path in \
  ".context-tree" \
  "skills/tree" \
  "assets/framework" \
  "src/engine" \
  "skills/first-tree/engine" \
  "skills/first-tree/assets" \
  "skills/first-tree/tests" \
  "skills/first-tree/scripts" \
  "skills/first-tree/agents" \
  "skills/first-tree/references/repo-snapshot"
do
  if git -C "$REPO_ROOT" ls-files --error-unmatch "$legacy_path" >/dev/null 2>&1; then
    echo "Unexpected legacy artifact tracked in git: $legacy_path" >&2
    exit 1
  fi
done

tracked_aliases="$(git -C "$REPO_ROOT" ls-files .agents .claude)"
expected_aliases=$'.agents/skills/first-tree\n.claude/skills/first-tree'
if [[ -n "$tracked_aliases" && "$tracked_aliases" != "$expected_aliases" ]]; then
  echo "Tracked .agents/.claude entries are out of sync with the expected local skill aliases." >&2
  printf 'Expected:\n%s\nGot:\n%s\n' "$expected_aliases" "$tracked_aliases" >&2
  exit 1
fi

if grep -q '"#docs/\*"' "$REPO_ROOT/package.json"; then
  echo "package.json still exposes the legacy #docs import alias." >&2
  exit 1
fi

if ! grep -q '"#skill/\*"' "$REPO_ROOT/package.json"; then
  echo "package.json is missing the canonical #skill import alias." >&2
  exit 1
fi

if ! grep -q '"#products/\*"' "$REPO_ROOT/package.json"; then
  echo "package.json is missing the canonical #products import alias." >&2
  exit 1
fi

if ! grep -q '"skills/first-tree"' "$REPO_ROOT/package.json"; then
  echo "package.json is missing skills/first-tree in the published files list." >&2
  exit 1
fi

if ! grep -q '"assets"' "$REPO_ROOT/package.json"; then
  echo "package.json is missing assets in the published files list." >&2
  exit 1
fi

MANIFEST_PATH="$REPO_ROOT/src/products/manifest.ts"
require_file "$MANIFEST_PATH"

if ! grep -q './tree/cli.js' "$MANIFEST_PATH"; then
  echo "src/products/manifest.ts is not lazy-loading the tree product dispatcher." >&2
  exit 1
fi

if ! grep -q './breeze/cli.js' "$MANIFEST_PATH"; then
  echo "src/products/manifest.ts is not lazy-loading the breeze product dispatcher." >&2
  exit 1
fi

if ! grep -q './gardener/cli.js' "$MANIFEST_PATH"; then
  echo "src/products/manifest.ts is not lazy-loading the gardener product dispatcher." >&2
  exit 1
fi

echo "Canonical skill structure is clean."
