#!/usr/bin/env bash
# Run all eval cases inside Docker with Claude Max plan.
#
# Usage:
#   bash evals/scripts/run-all-docker.sh
#
# Prerequisites:
#   - Docker image built: docker build -t ft-eval -f evals/Dockerfile .
#   - gh auth login (for GH_TOKEN)
#   - Claude Max plan authenticated (~/.claude/.credentials.json)

set -euo pipefail

IMAGE="${FT_EVAL_IMAGE:-${CT_EVAL_IMAGE:-ft-eval}}"

# Verify prerequisites
if ! docker image inspect "$IMAGE" &>/dev/null; then
  echo "Docker image '$IMAGE' not found. Build it first:"
  echo "  docker build -t ft-eval -f evals/Dockerfile ."
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

# Extract OAuth token and full credentials JSON
CLAUDE_TOKEN=$(python3 -c "import json; d=json.load(open('$HOME/.claude/.credentials.json')); print(d['claudeAiOauth']['accessToken'])")
CLAUDE_CREDS_JSON=$(python3 -c "import json; print(json.dumps(json.load(open('$HOME/.claude/.credentials.json'))))")
if [ -z "$CLAUDE_TOKEN" ]; then
  echo "Failed to extract OAuth token from ~/.claude/.credentials.json"
  exit 1
fi

# Ensure output directory exists
mkdir -p "$HOME/.first-tree/evals"

LOG_FILE="$HOME/.first-tree/evals/_run-$(date +%Y%m%d-%H%M%S).log"

echo "Starting eval run in Docker..."
echo "  Image: $IMAGE"
echo "  Results: ~/.first-tree/evals/"
echo "  Log: $LOG_FILE"
echo ""

# Prompt file is baked into the image at evals/scripts/eval-prompt.txt
# Write a startup script to a temp file, pipe credentials via env var
CREDS_B64=$(echo "$CLAUDE_CREDS_JSON" | base64 -w0)

# Named volume persists ~/.claude across container restarts
# Fix ownership on first use (volume is created as root)
docker run --rm --user root \
  -v ft-eval-claude-config:/home/eval/.claude \
  --entrypoint chown \
  "$IMAGE" \
  -R eval:eval /home/eval/.claude

docker run --rm -it \
  -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_TOKEN" \
  -e GH_TOKEN="$(gh auth token)" \
  -e _CREDS_B64="$CREDS_B64" \
  -v ft-eval-claude-config:/home/eval/.claude \
  -v "$HOME/.first-tree/evals:/home/eval/.first-tree/evals" \
  --entrypoint sh \
  "$IMAGE" \
  -c '
    # Inject credentials from host
    echo "$_CREDS_B64" | base64 -d > ~/.claude/.credentials.json
    chmod 600 ~/.claude/.credentials.json
    # Skip onboarding + accept permissions bypass
    echo "{\"hasCompletedOnboarding\":true,\"bypassPermissionsModeAccepted\":true}" > ~/.claude.json
    claude --dangerously-skip-permissions --model "opus[1m]"
  ' \
  2>&1 | tee "$LOG_FILE"

echo ""
echo "Done. Log saved to: $LOG_FILE"
