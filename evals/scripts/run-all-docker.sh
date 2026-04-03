#!/usr/bin/env bash
# Run all eval cases inside Docker with Claude Max plan.
#
# Usage:
#   bash evals/scripts/run-all-docker.sh
#
# Prerequisites:
#   - Docker image built: docker build -t ct-eval -f evals/Dockerfile .
#   - gh auth login (for GH_TOKEN)
#   - Claude Max plan authenticated (~/.claude/.credentials.json)

set -euo pipefail

IMAGE="${CT_EVAL_IMAGE:-ct-eval}"

# Verify prerequisites
if ! docker image inspect "$IMAGE" &>/dev/null; then
  echo "Docker image '$IMAGE' not found. Build it first:"
  echo "  docker build -t ct-eval -f evals/Dockerfile ."
  exit 1
fi

if ! gh auth token &>/dev/null; then
  echo "gh not authenticated. Run: gh auth login"
  exit 1
fi

if [ ! -f "$HOME/.claude/.credentials.json" ]; then
  echo "Claude credentials not found at ~/.claude/.credentials.json"
  echo "Run: claude login"
  exit 1
fi

# Ensure output directory exists
mkdir -p "$HOME/.context-tree/evals"

echo "Starting eval run in Docker..."
echo "  Image: $IMAGE"
echo "  Results: ~/.context-tree/evals/"
echo ""

exec docker run --rm \
  -e GH_TOKEN="$(gh auth token)" \
  -v "$HOME/.claude.json:/home/eval/.claude.json" \
  -v "$HOME/.claude:/home/eval/.claude" \
  -v "$HOME/.context-tree/evals:/home/eval/.context-tree/evals" \
  --entrypoint claude \
  "$IMAGE" \
  -p "$(cat <<'PROMPT'
You are working in the first-tree repo at /home/eval/first-tree. Read AGENT.md for context.

Your task: run ALL eval cases sequentially and fix any issues.

For each .yaml file in evals/cases/:

1. Check if the case has context_tree_versions defined. If it does, verify the tree exists by running:
   EVALS=1 EVALS_CASES='<case-id>' EVALS_CONDITIONS='baseline' EVALS_TREE_REPO='agent-team-foundation/eval-context-trees' pnpm run eval
   Then run with tree:
   EVALS=1 EVALS_CASES='<case-id>' EVALS_TREE_REPO='agent-team-foundation/eval-context-trees' pnpm run eval

2. If the case does NOT have context_tree_versions, first run baseline only:
   EVALS=1 EVALS_CASES='<case-id>' pnpm run eval
   If baseline passes, create a context tree:
   npx tsx evals/scripts/create-tree.ts --repo <repo> --commit <commit_sha> --cli-version $(git rev-parse --short HEAD) --tree-repo agent-team-foundation/eval-context-trees
   Then add the tree_sha to the case YAML under context_tree_versions and re-run with both conditions.

3. If a test case FAILS, inspect the verify.sh script and the error output. If the verification script has bugs (wrong paths, incorrect assertions, missing dependencies), fix the verify.sh and re-run. Do NOT modify the eval harness code — only fix verify.sh scripts.

4. After all cases are done, generate an aggregate HTML report:
   npx tsx evals/scripts/aggregate-report.ts ~/.context-tree/evals/*.json

Process cases in this order (smaller/faster first):
nanobot-exectool-regex, nanobot-streaming-metadata, pydantic-importstring-error, fastapi-optional-file-list, langchain-merge-parallel-tools, autogen-serialization-data-loss, autogen-provider-namespace-restriction, llamaindex-async-postprocess, llamaindex-run-id-passthrough, vercel-ai-oauth-trailing-slash, vercel-ai-error-code

Important:
- Run cases ONE AT A TIME (sequential, not parallel) to avoid API throttling.
- Set timeout to 10 minutes per case (600000ms).
- If a case times out or hits an unrecoverable error after 2 attempts, skip it and move on.
- Commit any verify.sh fixes or YAML updates before moving to the next case.
PROMPT
)" \
  --dangerously-skip-permissions \
  --verbose
