#!/bin/bash
# Verification for langchain-merge-parallel-tools eval case.
#
# Tests that merge_lists correctly keeps parallel tool calls with same index
# but different IDs separate, while still merging streaming continuations.

set -euo pipefail

cd "${SANDBOX_DIR:-.}"

# Run from the langchain-core package directory
cd libs/core

python3 << 'PYEOF'
import json, sys
sys.path.insert(0, ".")

passed = 0
total = 3

from langchain_core.utils._merge import merge_lists

# Test 1: Two parallel tool calls with same index but different IDs should NOT merge
left = [{"index": 0, "id": "call_1", "name": "tool_a", "args": "{}"}]
right = [{"index": 0, "id": "call_2", "name": "tool_b", "args": "{}"}]
result = merge_lists(left, right)

if result is not None and len(result) == 2:
    names = {r.get("name") for r in result}
    if "tool_a" in names and "tool_b" in names:
        passed += 1
        print("PASS: Parallel tool calls with different IDs kept separate")
    else:
        print(f"FAIL: Tool calls merged incorrectly: {result}")
else:
    print(f"FAIL: Expected 2 items, got {len(result) if result else 0}: {result}")

# Test 2: Streaming continuation (id=None) should still merge with parent
left = [{"index": 0, "id": "call_1", "name": "tool_a", "args": '{"x":'}]
right = [{"index": 0, "id": None, "name": None, "args": ' 1}'}]
result = merge_lists(left, right)

if result is not None and len(result) == 1:
    item = result[0]
    if item.get("id") == "call_1" and "1}" in (item.get("args") or ""):
        passed += 1
        print("PASS: Streaming continuation merged correctly")
    else:
        print(f"FAIL: Merge result unexpected: {item}")
else:
    print(f"FAIL: Expected 1 merged item, got {len(result) if result else 0}: {result}")

# Test 3: Three parallel tool calls all with same index should stay separate
items = [
    [{"index": 0, "id": "call_1", "name": "tool_a", "args": "{}"}],
    [{"index": 0, "id": "call_2", "name": "tool_b", "args": "{}"}],
    [{"index": 0, "id": "call_3", "name": "tool_c", "args": "{}"}],
]
result = merge_lists(*items)

if result is not None and len(result) == 3:
    names = {r.get("name") for r in result}
    if names == {"tool_a", "tool_b", "tool_c"}:
        passed += 1
        print("PASS: Three parallel tool calls all kept separate")
    else:
        print(f"FAIL: Names not preserved: {result}")
else:
    print(f"FAIL: Expected 3 items, got {len(result) if result else 0}: {result}")

print(json.dumps({"passed": passed, "total": total}))
PYEOF
