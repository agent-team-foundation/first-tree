#!/bin/bash
# Injects NODE.md content as additionalContext at session start.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TREE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
NODE_MD="$TREE_ROOT/NODE.md"

if [ -f "$NODE_MD" ]; then
  # Escape for JSON: backslashes, double quotes, newlines, tabs, carriage returns
  CONTENT=$(sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/\\t/g' -e 's/\r/\\r/g' "$NODE_MD" | awk '{printf "%s\\n", $0}' | sed 's/\\n$//')
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"${CONTENT}\"}}"
  exit 0
fi

exit 0
