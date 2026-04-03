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

# Use a named volume for Claude credentials (persists across runs)
CLAUDE_VOL="ct-eval-claude-home"

# Check if credentials exist in the volume
if ! docker run --rm -v "$CLAUDE_VOL:/home/eval/.claude" --entrypoint sh "$IMAGE" -c 'test -f /home/eval/.claude/.credentials.json' 2>/dev/null; then
  echo "Claude credentials not set up in Docker volume '$CLAUDE_VOL'."
  echo "Launching interactive Claude for login..."
  echo ""
  docker run --rm -it \
    -v "$CLAUDE_VOL:/home/eval/.claude" \
    --entrypoint claude \
    "$IMAGE"
  echo ""
  echo "Login complete. Re-run this script to start evals."
  exit 0
fi

# Ensure output directory exists
mkdir -p "$HOME/.context-tree/evals"

# Write prompt to a temp file (avoids shell quoting issues)
PROMPT_FILE="$(mktemp)"
trap 'rm -f "$PROMPT_FILE"' EXIT

cat > "$PROMPT_FILE" <<'PROMPT'
You are working in the first-tree repo at /home/eval/first-tree. Read AGENT.md for context.

Your task: run ALL eval cases sequentially and fix any issues.

For each .yaml file in evals/cases/:

1. Check if the case has context_tree_versions defined. If it does, run:
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

LOG_FILE="$HOME/.context-tree/evals/_run-$(date +%Y%m%d-%H%M%S).log"

echo "Starting eval run in Docker..."
echo "  Image: $IMAGE"
echo "  Results: ~/.context-tree/evals/"
echo "  Log: $LOG_FILE"
echo "  Follow with: tail -f $LOG_FILE"
echo ""

docker run --rm \
  -e GH_TOKEN="$(gh auth token)" \
  -v "$CLAUDE_VOL:/home/eval/.claude" \
  -v "$HOME/.context-tree/evals:/home/eval/.context-tree/evals" \
  -v "$PROMPT_FILE:/tmp/eval-prompt.txt:ro" \
  --entrypoint sh \
  "$IMAGE" \
  -c 'claude -p "$(cat /tmp/eval-prompt.txt)" --dangerously-skip-permissions --output-format stream-json --verbose 2>&1 | tee /home/eval/.context-tree/evals/_run.log' &

DOCKER_PID=$!

# Wait for log file to appear, then tail it
for i in $(seq 1 10); do
  if [ -f "$HOME/.context-tree/evals/_run.log" ]; then
    break
  fi
  sleep 1
done

tail -f "$HOME/.context-tree/evals/_run.log" &
TAIL_PID=$!

# Wait for docker to finish, then stop tail
wait "$DOCKER_PID" 2>/dev/null
EXIT_CODE=$?
kill "$TAIL_PID" 2>/dev/null

# Copy log with timestamp
cp "$HOME/.context-tree/evals/_run.log" "$LOG_FILE" 2>/dev/null

echo ""
echo "Done. Exit code: $EXIT_CODE"
echo "Log saved to: $LOG_FILE"
exit "$EXIT_CODE"
