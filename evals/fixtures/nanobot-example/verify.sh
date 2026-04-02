#!/bin/bash
# Verification for nanobot-exectool-regex eval case.
#
# Tests that the ExecTool regex fix was applied correctly.
# The bug: regex uses `+` quantifier which requires >=1 char after `\`,
# so bare `E:\` is missed. Fix: change `+` to `*`.

set -euo pipefail

cd "${SANDBOX_DIR:-.}"

python3 << 'PYEOF'
import re, json

passed = 0
total = 2

with open("nanobot/agent/tools/shell.py") as f:
    source = f.read()

# Find the win_paths line and extract the regex pattern between r" and "
match = re.search(r'win_paths\s*=\s*re\.findall\(r"(.+?)",\s*command\)', source)
if not match:
    print("FAIL: Could not find win_paths regex in shell.py")
    print(json.dumps({"passed": 0, "total": total}))
    exit(0)

raw_pattern = match.group(1)

# Test 1: The pattern must use * (not +) so bare drive roots are matched.
# The key part is: [^\s"'|><;]* (with * allowing zero characters after \)
# We test this by running the regex against "dir E:\"
#
# Since the pattern is inside r"...", we need to reconstruct it.
# The source has: [A-Za-z]:\\[^\s\"'|><;]* (with \" being a literal quote in the r-string)
# In Python, inside r"...", \" is the two chars \ and "... but actually it just escapes the quote.
# The actual regex pattern as Python sees it is: [A-Za-z]:\[^\s"'|><;]*
#
# Simplest check: does the pattern end with * or + before the closing?
if raw_pattern.endswith("*"):
    passed += 1
    print("PASS: regex uses * quantifier (matches zero-length suffix)")
elif raw_pattern.endswith("+"):
    print("FAIL: regex still uses + quantifier (misses bare drive roots like E:\\)")
else:
    # The agent may have rewritten the regex differently — test empirically
    print(f"INFO: unexpected pattern ending: ...{raw_pattern[-10:]}")
    # Try to compile and test it
    try:
        # Reconstruct: the \" in source means literal " in the regex
        test_pattern = raw_pattern.replace('\\"', '"')
        paths = re.findall(test_pattern, "dir E:\\")
        if paths and "E:\\" in paths:
            passed += 1
            print("PASS: regex captures E:\\ (alternative fix)")
        else:
            print(f"FAIL: regex does not capture E:\\ (result: {paths!r})")
    except re.error as e:
        print(f"FAIL: regex compilation error: {e}")

# Test 2: Verify the regex still captures full paths (no regression)
try:
    test_pattern = raw_pattern.replace('\\"', '"')
    paths = re.findall(test_pattern, "dir C:\\Users\\foo\\bar.txt")
    if paths and any("C:\\" in p for p in paths):
        passed += 1
        print(f"PASS: regex captures full path ({paths})")
    else:
        print(f"FAIL: regex does not capture full Windows path (result: {paths!r})")
except re.error as e:
    print(f"FAIL: regex compilation error: {e}")

print(json.dumps({"passed": passed, "total": total}))
PYEOF
