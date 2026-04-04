#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

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

require_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "Missing file: $path" >&2
    exit 1
  fi
}

REPO_ROOT="$(find_repo_root || true)"
SOURCE_DIR=""
if [[ -n "$REPO_ROOT" ]]; then
  SOURCE_DIR="$REPO_ROOT/skills/first-tree"
fi

if [[ -z "$REPO_ROOT" || "$SKILL_DIR" != "$SOURCE_DIR" ]]; then
  echo "Run this script from the source-of-truth skill at skills/first-tree inside a live first-tree checkout." >&2
  exit 1
fi

require_file "$SOURCE_DIR/SKILL.md"
require_file "$SOURCE_DIR/agents/openai.yaml"
require_file "$SOURCE_DIR/references/about.md"
require_file "$SOURCE_DIR/references/onboarding.md"
require_file "$SOURCE_DIR/references/principles.md"
require_file "$SOURCE_DIR/references/ownership-and-naming.md"
require_file "$SOURCE_DIR/references/source-map.md"
require_file "$SOURCE_DIR/references/upgrade-contract.md"
require_file "$SOURCE_DIR/references/maintainer-architecture.md"
require_file "$SOURCE_DIR/references/maintainer-thin-cli.md"
require_file "$SOURCE_DIR/references/maintainer-build-and-distribution.md"
require_file "$SOURCE_DIR/references/maintainer-testing.md"
require_file "$SOURCE_DIR/engine/init.ts"
require_file "$SOURCE_DIR/engine/onboarding.ts"
require_file "$SOURCE_DIR/engine/repo.ts"
require_file "$SOURCE_DIR/engine/upgrade.ts"
require_file "$SOURCE_DIR/engine/verify.ts"
require_file "$SOURCE_DIR/engine/commands/help.ts"
require_file "$SOURCE_DIR/engine/commands/init.ts"
require_file "$SOURCE_DIR/engine/commands/upgrade.ts"
require_file "$SOURCE_DIR/engine/commands/verify.ts"
require_file "$SOURCE_DIR/engine/rules/index.ts"
require_file "$SOURCE_DIR/engine/runtime/asset-loader.ts"
require_file "$SOURCE_DIR/engine/runtime/installer.ts"
require_file "$SOURCE_DIR/engine/runtime/upgrader.ts"
require_file "$SOURCE_DIR/engine/runtime/adapters.ts"
require_file "$SOURCE_DIR/engine/validators/members.ts"
require_file "$SOURCE_DIR/engine/validators/nodes.ts"
require_file "$SOURCE_DIR/tests/init.test.ts"
require_file "$SOURCE_DIR/tests/verify.test.ts"
require_file "$SOURCE_DIR/tests/skill-artifacts.test.ts"
require_file "$SOURCE_DIR/assets/framework/manifest.json"
require_file "$SOURCE_DIR/assets/framework/VERSION"
require_file "$SOURCE_DIR/assets/framework/prompts/pr-review.md"
require_file "$SOURCE_DIR/assets/framework/templates/root-node.md.template"
require_file "$SOURCE_DIR/assets/framework/templates/agent.md.template"
require_file "$SOURCE_DIR/assets/framework/templates/members-domain.md.template"
require_file "$SOURCE_DIR/assets/framework/templates/member-node.md.template"
require_file "$SOURCE_DIR/assets/framework/workflows/validate.yml"
require_file "$SOURCE_DIR/assets/framework/workflows/pr-review.yml"
require_file "$SOURCE_DIR/assets/framework/workflows/codeowners.yml"
require_file "$SOURCE_DIR/assets/framework/examples/claude-code/README.md"
require_file "$SOURCE_DIR/assets/framework/examples/claude-code/settings.json"
require_file "$SOURCE_DIR/assets/framework/helpers/generate-codeowners.ts"
require_file "$SOURCE_DIR/assets/framework/helpers/run-review.ts"
require_file "$SOURCE_DIR/assets/framework/helpers/inject-tree-context.sh"

# Check for legacy artifacts that should not be committed.
# Use git ls-files to ignore untracked local files (e.g. .claude/settings.local.json).
for legacy_path in \
  ".agents" \
  ".claude" \
  ".context-tree" \
  "docs" \
  "skills/first-tree-cli-framework" \
  "tests" \
  "skills/first-tree/references/repo-snapshot"
do
  if git -C "$REPO_ROOT" ls-files --error-unmatch "$legacy_path" >/dev/null 2>&1; then
    echo "Unexpected legacy artifact tracked in git: $legacy_path" >&2
    exit 1
  fi
done

if [[ -e "$SOURCE_DIR/evals" ]]; then
  echo "Skill should not contain repo-only eval tooling." >&2
  exit 1
fi

require_file "$REPO_ROOT/evals/context-tree-eval.test.ts"
require_file "$REPO_ROOT/evals/README.md"
require_file "$REPO_ROOT/evals/helpers/case-loader.ts"
require_file "$REPO_ROOT/evals/scripts/tree-manager.ts"
require_file "$REPO_ROOT/evals/tests/eval-helpers.test.ts"

if grep -q '"#docs/\*"' "$REPO_ROOT/package.json"; then
  echo "package.json still exposes the legacy #docs import alias." >&2
  exit 1
fi

if ! grep -q '"#skill/\*"' "$REPO_ROOT/package.json"; then
  echo "package.json is missing the canonical #skill import alias." >&2
  exit 1
fi

if ! grep -q '"skills/first-tree"' "$REPO_ROOT/package.json"; then
  echo "package.json is missing the canonical skill in the published files list." >&2
  exit 1
fi

if ! grep -q '#skill/engine/commands/init.js' "$REPO_ROOT/src/cli.ts"; then
  echo "src/cli.ts is not dispatching to the skill-owned engine." >&2
  exit 1
fi

echo "Canonical skill structure is clean."
