#!/bin/bash
# Verification for nanobot-streaming-metadata eval case.
#
# Tests that on_stream and on_stream_end closures preserve inbound metadata.
# The bug: closures create fresh dicts with only internal keys, dropping
# channel-specific fields like message_thread_id.

set -euo pipefail

cd "${SANDBOX_DIR:-.}"

python3 << 'PYEOF'
import json, ast, re

passed = 0
total = 3

# Read the source file
with open("nanobot/agent/loop.py") as f:
    source = f.read()

# Test 1: on_stream closure copies msg.metadata (not a fresh dict)
# Look for the on_stream closure — it should reference msg.metadata
# The fix pattern: dict(msg.metadata or {}) with _stream_delta added on top
if re.search(r'msg\.metadata', source) and re.search(r'_stream_delta', source):
    # Check that metadata is being copied, not created fresh
    # The key indicator: the on_stream function builds metadata FROM msg.metadata
    # Look for pattern like: {**msg.metadata, ...} or dict(msg.metadata or {})
    # or msg.metadata | {...} or similar
    on_stream_section = source[source.find('on_stream'):source.find('on_stream') + 2000] if 'on_stream' in source else ''

    if ('msg.metadata' in on_stream_section and
        ('dict(msg.metadata' in on_stream_section or
         '{**msg.metadata' in on_stream_section or
         '**msg.metadata' in on_stream_section or
         'msg.metadata |' in on_stream_section or
         '| msg.metadata' in on_stream_section or
         '.update(' in on_stream_section or
         'copy()' in on_stream_section)):
        passed += 1
        print("PASS: on_stream copies msg.metadata")
    else:
        print("FAIL: on_stream doesn't appear to copy msg.metadata")
else:
    print("FAIL: Could not find on_stream with msg.metadata reference")

# Test 2: on_stream_end closure also copies msg.metadata
# Find the on_stream_end section
if 'on_stream_end' in source:
    # Find on_stream_end definition and check for metadata copying
    end_idx = source.find('on_stream_end')
    on_stream_end_section = source[end_idx:end_idx + 2000]

    if ('msg.metadata' in on_stream_end_section and
        ('dict(msg.metadata' in on_stream_end_section or
         '{**msg.metadata' in on_stream_end_section or
         '**msg.metadata' in on_stream_end_section or
         'msg.metadata |' in on_stream_end_section or
         '| msg.metadata' in on_stream_end_section or
         '.update(' in on_stream_end_section or
         'copy()' in on_stream_end_section)):
        passed += 1
        print("PASS: on_stream_end copies msg.metadata")
    else:
        print("FAIL: on_stream_end doesn't appear to copy msg.metadata")
else:
    print("FAIL: Could not find on_stream_end function")

# Test 3: Check for test file existence with metadata preservation tests
import os
test_files = []
for root, dirs, files in os.walk("tests"):
    for f in files:
        if f.endswith(".py"):
            path = os.path.join(root, f)
            try:
                content = open(path).read()
                if 'message_thread_id' in content and ('on_stream' in content or 'metadata' in content):
                    test_files.append(path)
            except:
                pass

if test_files:
    passed += 1
    print(f"PASS: Found metadata preservation tests in {test_files}")
else:
    # Try running pytest to find relevant tests
    print("FAIL: No test files found with message_thread_id + on_stream/metadata checks")

print(json.dumps({"passed": passed, "total": total}))
PYEOF
