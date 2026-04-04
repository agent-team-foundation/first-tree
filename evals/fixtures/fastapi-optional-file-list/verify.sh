#!/bin/bash
# Verification for fastapi-optional-file-list eval case.
#
# The bug: Optional[List[bytes]] crashes with TypeError: issubclass() arg 1
# must be a class — because Union types aren't classes.
#
# We test via the internal compat functions which is where the bug lives,
# avoiding FastAPI app construction which varies across commits.

set -euo pipefail

cd "${SANDBOX_DIR:-.}"
source .venv/bin/activate 2>/dev/null || true
export PATH=".venv/bin:$PATH"

python3 << 'PYEOF'
import json

passed = 0
total = 2

# Test 1: is_bytes_sequence_field handles Optional[List[bytes]] without TypeError
try:
    from typing import Optional, List
    from fastapi._compat.v2 import is_bytes_sequence_field, ModelField
    from pydantic.fields import FieldInfo

    fi = FieldInfo(annotation=Optional[List[bytes]])
    mf = ModelField(field_info=fi, name="test")
    result = is_bytes_sequence_field(mf)
    if result is True:
        passed += 1
        print("PASS: is_bytes_sequence_field(Optional[List[bytes]]) returns True")
    else:
        print(f"FAIL: is_bytes_sequence_field returned {result}, expected True")
except TypeError as e:
    if "issubclass" in str(e):
        print(f"FAIL: TypeError still raised: {e}")
    else:
        print(f"FAIL: Unexpected TypeError: {e}")
except Exception as e:
    print(f"FAIL: {type(e).__name__}: {e}")

# Test 2: serialize_sequence_value handles Optional[List[bytes]] without TypeError
try:
    from fastapi._compat.v2 import serialize_sequence_value

    fi2 = FieldInfo(annotation=Optional[List[str]])
    mf2 = ModelField(field_info=fi2, name="test2")
    result = serialize_sequence_value(field=mf2, value=["a", "b"])
    if isinstance(result, (list, tuple)) and list(result) == ["a", "b"]:
        passed += 1
        print("PASS: serialize_sequence_value handles Optional[List[str]]")
    else:
        print(f"FAIL: Unexpected result: {result}")
except TypeError as e:
    if "issubclass" in str(e):
        print(f"FAIL: TypeError still raised: {e}")
    else:
        print(f"FAIL: Unexpected TypeError: {e}")
except Exception as e:
    print(f"FAIL: {type(e).__name__}: {e}")

print(json.dumps({"passed": passed, "total": total}))
PYEOF
