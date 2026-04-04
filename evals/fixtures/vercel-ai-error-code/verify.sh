#!/bin/bash
# Verification for vercel-ai-error-code eval case.
#
# The bug: structured error data from provider-executed tools is lost through
# the streaming pipeline. The Anthropic converter uses 'unknown' as fallback
# error code for web_fetch errors.
#
# The fix: preserve error data for providerExecuted tools, and change the
# web_fetch fallback error code from 'unknown' to something more descriptive.

set -euo pipefail

cd "${SANDBOX_DIR:-.}"

passed=0
total=2

# Test 1: stream-text.ts handles providerExecuted tool errors
STREAM_TEXT="packages/ai/src/generate-text/stream-text.ts"
if [ -f "$STREAM_TEXT" ]; then
    if grep -q "providerExecuted" "$STREAM_TEXT" && grep -q "JSON.stringify" "$STREAM_TEXT"; then
        echo "PASS: stream-text.ts handles providerExecuted tool errors"
        passed=$((passed + 1))
    else
        echo "FAIL: stream-text.ts missing providerExecuted + JSON.stringify handling"
    fi
else
    echo "FAIL: $STREAM_TEXT not found"
fi

# Test 2: Anthropic prompt converter no longer uses 'unknown' for web_fetch errors.
# Note: code_execution sections may still use 'unknown' — that's unrelated.
ANTHROPIC_PROMPT="packages/anthropic/src/convert-to-anthropic-messages-prompt.ts"
if [ -f "$ANTHROPIC_PROMPT" ]; then
    # Extract only the web_fetch sections (within ~5 lines of web_fetch references)
    web_fetch_context=$(grep -B2 -A5 "web_fetch" "$ANTHROPIC_PROMPT" || true)
    if echo "$web_fetch_context" | grep -q "'unknown'\|\"unknown\""; then
        echo "FAIL: web_fetch sections still use 'unknown' as fallback"
    else
        echo "PASS: web_fetch error handling no longer uses 'unknown' fallback"
        passed=$((passed + 1))
    fi
else
    echo "FAIL: $ANTHROPIC_PROMPT not found"
fi

echo "{\"passed\": $passed, \"total\": $total}"
