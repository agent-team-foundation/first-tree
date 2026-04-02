#!/bin/bash
# Verification for pydantic-importstring-error eval case.
#
# Tests that _import_string_logic surfaces the real ModuleNotFoundError for
# broken internal imports instead of masking it as "No module named X".
#
# Uses the low-level import function directly to avoid requiring pydantic-core
# Rust compilation.

set -euo pipefail

cd "${SANDBOX_DIR:-.}"

python3 << 'PYEOF'
import json, sys, os, tempfile

passed = 0
total = 2

# Import the internal function directly
sys.path.insert(0, ".")
from pydantic._internal._validators import _import_string_logic

# Test 1: Module with broken internal import should surface the real error
tmpdir = tempfile.mkdtemp()
mod_path = os.path.join(tmpdir, "broken_mod_eval.py")
with open(mod_path, "w") as f:
    f.write("import definitely_missing_dep_xyz_eval\n")

sys.path.insert(0, tmpdir)

try:
    try:
        _import_string_logic("broken_mod_eval")
        print("FAIL: No error raised for broken module")
    except ModuleNotFoundError as e:
        if "definitely_missing_dep_xyz_eval" in str(e):
            passed += 1
            print(f"PASS: Real ModuleNotFoundError surfaced: {e}")
        elif "broken_mod_eval" in str(e):
            print(f"FAIL: Error masked as 'No module named broken_mod_eval': {e}")
        else:
            print(f"FAIL: Unexpected error message: {e}")
    except ImportError as e:
        # The function wraps some errors in ImportError
        if "definitely_missing_dep_xyz_eval" in str(e):
            passed += 1
            print(f"PASS: Real error surfaced (as ImportError): {e}")
        else:
            print(f"FAIL: ImportError but wrong message: {e}")
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

# Test 2: Explicit colon path should not trigger dot-fallback incorrectly
try:
    try:
        result = _import_string_logic("os:path")
        # os:path should work — it's a valid attribute
        import os.path as ospath
        if result is ospath:
            # Now test that a non-existent attribute raises properly
            try:
                _import_string_logic("os:nonexistent_attr_xyz")
                print("FAIL: No error raised for nonexistent attribute")
            except (ImportError, AttributeError) as e:
                if "nonexistent_attr_xyz" in str(e):
                    passed += 1
                    print(f"PASS: Explicit colon path handled correctly: {e}")
                else:
                    print(f"FAIL: Wrong error for colon path: {e}")
        else:
            print(f"FAIL: os:path returned unexpected value: {result}")
    except Exception as e:
        print(f"FAIL: os:path raised error: {type(e).__name__}: {e}")
except Exception as e:
    print(f"FAIL: Could not test colon path: {type(e).__name__}: {e}")

print(json.dumps({"passed": passed, "total": total}))
PYEOF
