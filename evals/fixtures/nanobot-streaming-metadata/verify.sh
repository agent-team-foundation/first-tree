#!/bin/bash
# Verification for nanobot-streaming-metadata eval case.
#
# The bug: on_stream and on_stream_end closures create fresh metadata dicts
# with only internal keys (_stream_delta, _stream_end, etc.), dropping
# channel-specific fields like message_thread_id from the inbound message.
#
# The fix: closures must build metadata FROM msg.metadata (copy + merge)
# instead of creating fresh dicts.

set -euo pipefail

cd "${SANDBOX_DIR:-.}"

python3 << 'PYEOF'
import json, re

passed = 0
total = 2

with open("nanobot/agent/loop.py") as f:
    source = f.read()

# The bug: on_stream closure has metadata={"_stream_delta": True, ...}
# (fresh dict, drops msg.metadata). The fix replaces it with
# meta = dict(msg.metadata or {}); meta["_stream_delta"] = True

# Test 1: on_stream closure must NOT have a fresh metadata dict with _stream_delta
# Look for the buggy pattern: metadata={\n..._stream_delta
buggy_pattern = re.search(
    r'async def on_stream\(delta.*?\n'     # on_stream definition
    r'(?:.*\n)*?'                           # any lines
    r'.*metadata\s*=\s*\{[^}]*_stream_delta',  # fresh dict with _stream_delta
    source,
)
if buggy_pattern:
    print("FAIL: on_stream still creates a fresh metadata dict (drops msg.metadata)")
else:
    passed += 1
    print("PASS: on_stream no longer creates a fresh metadata dict")

# Test 2: on_stream_end closure must NOT have a fresh metadata dict with _stream_end
buggy_pattern_end = re.search(
    r'async def on_stream_end\(.*?\n'      # on_stream_end definition
    r'(?:.*\n)*?'                           # any lines
    r'.*metadata\s*=\s*\{[^}]*_stream_end', # fresh dict with _stream_end
    source,
)
if buggy_pattern_end:
    print("FAIL: on_stream_end still creates a fresh metadata dict (drops msg.metadata)")
else:
    passed += 1
    print("PASS: on_stream_end no longer creates a fresh metadata dict")

print(json.dumps({"passed": passed, "total": total}))
PYEOF
