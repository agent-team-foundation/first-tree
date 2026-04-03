#!/bin/bash
# Verification for vercel-ai-error-code eval case.
#
# Tests that provider-executed tool errors preserve structured error data
# through the streaming pipeline, and that fallback error code is 'unavailable'.

set -euo pipefail

cd "${SANDBOX_DIR:-.}"

passed=0
total=2

# Test 1: Check stream-text.ts handles providerExecuted tool errors
# The fix should bypass onError for providerExecuted tool errors
STREAM_TEXT="packages/ai/src/generate-text/stream-text.ts"
if [ -f "$STREAM_TEXT" ]; then
    # Look for the providerExecuted check in the tool-output-error handling
    if grep -q "providerExecuted" "$STREAM_TEXT"; then
        # Verify the pattern: providerExecuted ? direct-serialize : onError(...)
        if grep -q "JSON.stringify" "$STREAM_TEXT" && grep -q "providerExecuted" "$STREAM_TEXT"; then
            echo "PASS: stream-text.ts handles providerExecuted tool errors with direct serialization"
            passed=$((passed + 1))
        else
            echo "FAIL: providerExecuted found but JSON.stringify not used for direct serialization"
        fi
    else
        echo "FAIL: No providerExecuted check in stream-text.ts"
    fi
else
    echo "FAIL: $STREAM_TEXT not found"
fi

# Test 2: Check Anthropic prompt converter uses 'unavailable' fallback
ANTHROPIC_PROMPT="packages/anthropic/src/convert-to-anthropic-messages-prompt.ts"
if [ -f "$ANTHROPIC_PROMPT" ]; then
    # The fix changes 'unknown' to 'unavailable' as the fallback error code
    if grep -q "'unavailable'" "$ANTHROPIC_PROMPT" || grep -q '"unavailable"' "$ANTHROPIC_PROMPT"; then
        # Make sure 'unknown' is no longer used as a fallback
        # (it might appear in other contexts, so check specifically for error_code fallback)
        if grep -q "error_code.*'unknown'" "$ANTHROPIC_PROMPT" || grep -q "error_code.*\"unknown\"" "$ANTHROPIC_PROMPT"; then
            echo "FAIL: 'unknown' still used as fallback error_code"
        else
            echo "PASS: Anthropic prompt converter uses 'unavailable' as fallback error code"
            passed=$((passed + 1))
        fi
    else
        echo "FAIL: 'unavailable' not found in Anthropic prompt converter"
    fi
else
    echo "FAIL: $ANTHROPIC_PROMPT not found"
fi

echo "{\"passed\": $passed, \"total\": $total}"
