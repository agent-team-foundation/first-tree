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

# Extract OAuth token from credentials
CLAUDE_TOKEN=$(python3 -c "import json; d=json.load(open('$HOME/.claude/.credentials.json')); print(d['claudeAiOauth']['accessToken'])")
if [ -z "$CLAUDE_TOKEN" ]; then
  echo "Failed to extract OAuth token from ~/.claude/.credentials.json"
  exit 1
fi

# Ensure output directory exists
mkdir -p "$HOME/.context-tree/evals"

LOG_FILE="$HOME/.context-tree/evals/_run-$(date +%Y%m%d-%H%M%S).log"

echo "Starting eval run in Docker..."
echo "  Image: $IMAGE"
echo "  Results: ~/.context-tree/evals/"
echo "  Log: $LOG_FILE"
echo ""

# Prompt file is baked into the image at evals/scripts/eval-prompt.txt
docker run --rm \
  -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_TOKEN" \
  -e GH_TOKEN="$(gh auth token)" \
  -v "$HOME/.context-tree/evals:/home/eval/.context-tree/evals" \
  --entrypoint sh \
  "$IMAGE" \
  -c 'echo "{\"bypassPermissionsModeAccepted\": true}" > ~/.claude.json && claude -p "$(cat evals/scripts/eval-prompt.txt)" --dangerously-skip-permissions --output-format stream-json --verbose' \
  2>&1 | tee "$LOG_FILE"

echo ""
echo "Done. Log saved to: $LOG_FILE"
