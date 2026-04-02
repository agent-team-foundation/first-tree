#!/bin/bash
# Verification for pydantic-importstring-error eval case.
#
# Tests that ImportString surfaces the real ModuleNotFoundError for broken
# internal imports instead of masking it as "No module named X".

set -euo pipefail

cd "${SANDBOX_DIR:-.}"

python3 << 'PYEOF'
import json, sys, os, tempfile

passed = 0
total = 2

# Test 1: Module with broken internal import should surface the real error
# Create a temporary module that imports a nonexistent dependency
tmpdir = tempfile.mkdtemp()
mod_path = os.path.join(tmpdir, "broken_mod.py")
with open(mod_path, "w") as f:
    f.write("import definitely_missing_dep_xyz\n")

sys.path.insert(0, tmpdir)

try:
    from pydantic import TypeAdapter, ImportString

    ta = TypeAdapter(ImportString)
    try:
        ta.validate_python("broken_mod")
        print("FAIL: No error raised for broken module")
    except ModuleNotFoundError as e:
        # The real error should mention the missing dependency, not the module itself
        if "definitely_missing_dep_xyz" in str(e):
            passed += 1
            print(f"PASS: Real ModuleNotFoundError surfaced: {e}")
        elif "broken_mod" in str(e):
            print(f"FAIL: Error masked as 'No module named broken_mod': {e}")
        else:
            print(f"FAIL: Unexpected error message: {e}")
    except Exception as e:
        # Check if it's an ImportError that mentions the real dependency
        if "definitely_missing_dep_xyz" in str(e):
            passed += 1
            print(f"PASS: Real error surfaced (as {type(e).__name__}): {e}")
        else:
            print(f"FAIL: Unexpected error: {type(e).__name__}: {e}")
finally:
    sys.path.remove(tmpdir)
    # Clean up
    try:
        os.unlink(mod_path)
        os.rmdir(tmpdir)
    except:
        pass
    # Remove from module cache
    sys.modules.pop("broken_mod", None)

# Test 2: Explicit colon path should not trigger dot-fallback incorrectly
try:
    ta = TypeAdapter(ImportString)
    try:
        ta.validate_python("os:nonexistent_attr")
        print("FAIL: No error raised for nonexistent attribute")
    except (ImportError, AttributeError) as e:
        # Should get an AttributeError or ImportError about the attribute, not crash
        if "nonexistent_attr" in str(e):
            passed += 1
            print(f"PASS: Explicit colon path handled correctly: {e}")
        else:
            print(f"FAIL: Unexpected error for colon path: {e}")
    except Exception as e:
        print(f"FAIL: Unexpected error: {type(e).__name__}: {e}")
except Exception as e:
    print(f"FAIL: Could not test colon path: {type(e).__name__}: {e}")

print(json.dumps({"passed": passed, "total": total}))
PYEOF
