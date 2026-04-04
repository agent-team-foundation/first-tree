#!/bin/bash
# Verification for pydantic-importstring-error eval case.
#
# The bug: _import_string_logic("pkg.Class") where pkg has a broken internal
# import masks the real error as "No module named 'pkg.Class'" instead of
# surfacing the actual dependency error from inside pkg.
#
# The fix must ensure the real ModuleNotFoundError propagates.

set -euo pipefail

cd "${SANDBOX_DIR:-.}"
source .venv/bin/activate 2>/dev/null || true
export PATH=".venv/bin:$PATH"

python3 << 'PYEOF'
import json, sys, os, tempfile

passed = 0
total = 2

sys.path.insert(0, ".")
from pydantic._internal._validators import _import_string_logic

# Test 1: Dotted path with broken internal import must surface the REAL error.
# On unfixed code: raises "No module named 'broken_mod_eval.MyClass'" (masked).
# On fixed code: raises "No module named 'definitely_missing_dep_xyz_eval'" (real).
tmpdir = tempfile.mkdtemp()
mod_path = os.path.join(tmpdir, "broken_mod_eval.py")
with open(mod_path, "w") as f:
    f.write("import definitely_missing_dep_xyz_eval\nclass MyClass: pass\n")

sys.path.insert(0, tmpdir)

try:
    try:
        _import_string_logic("broken_mod_eval.MyClass")
        print("FAIL: No error raised for broken module")
    except (ModuleNotFoundError, ImportError) as e:
        msg = str(e)
        if "definitely_missing_dep_xyz_eval" in msg:
            passed += 1
            print(f"PASS: Real dependency error surfaced: {e}")
        elif "broken_mod_eval" in msg:
            print(f"FAIL: Error masked as 'No module named broken_mod_eval.MyClass': {e}")
        else:
            print(f"FAIL: Unexpected error message: {e}")
    except Exception as e:
        print(f"FAIL: Unexpected error: {type(e).__name__}: {e}")
finally:
    sys.path.remove(tmpdir)
    try:
        os.unlink(mod_path)
        os.rmdir(tmpdir)
    except:
        pass
    sys.modules.pop("broken_mod_eval", None)

# Test 2: Valid dotted import should still work
try:
    result = _import_string_logic("os.path")
    import os.path as ospath
    if result is ospath:
        passed += 1
        print("PASS: Valid dotted import works correctly")
    else:
        print(f"FAIL: os.path returned unexpected value: {result}")
except Exception as e:
    print(f"FAIL: os.path raised error: {type(e).__name__}: {e}")

print(json.dumps({"passed": passed, "total": total}))
PYEOF
