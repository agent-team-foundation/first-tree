#!/bin/bash
# Verification for fastapi-optional-file-list eval case.
#
# Tests that Optional[List[bytes]] file upload parameters work without
# TypeError: issubclass() arg 1 must be a class.

set -euo pipefail

cd "${SANDBOX_DIR:-.}"

python3 << 'PYEOF'
import json

passed = 0
total = 3

# Test 1: serialize_sequence_value handles Union[List[str], None]
try:
    from typing import List, Union
    from pydantic import field_serializer
    from pydantic.fields import FieldInfo
    from fastapi._compat import serialize_sequence_value, ModelField

    # Create a ModelField with Union[List[str], None] annotation
    fi = FieldInfo(annotation=Union[List[str], None])
    mf = ModelField(field_info=fi, name="test")
    result = serialize_sequence_value(field=mf, value=["a", "b"])
    if isinstance(result, list) and result == ["a", "b"]:
        passed += 1
        print("PASS: serialize_sequence_value handles Union[List[str], None]")
    else:
        print(f"FAIL: Unexpected result: {result}")
except TypeError as e:
    if "issubclass" in str(e):
        print(f"FAIL: TypeError still raised: {e}")
    else:
        print(f"FAIL: Unexpected TypeError: {e}")
except Exception as e:
    print(f"FAIL: Unexpected error: {type(e).__name__}: {e}")

# Test 2: Endpoint with Optional[List[bytes]] accepts file uploads
try:
    from typing import Optional
    from fastapi import FastAPI, File
    from fastapi.testclient import TestClient

    app = FastAPI()

    @app.post("/files")
    async def upload_files(files: Optional[List[bytes]] = File(None)):
        if files is None:
            return {"files_count": 0}
        return {"files_count": len(files), "sizes": [len(f) for f in files]}

    client = TestClient(app)
    response = client.post(
        "/files",
        files=[("files", b"content1"), ("files", b"content2")],
    )
    if response.status_code == 200:
        data = response.json()
        if data.get("files_count") == 2 and data.get("sizes") == [8, 8]:
            passed += 1
            print("PASS: File upload with Optional[List[bytes]] works")
        else:
            print(f"FAIL: Unexpected response data: {data}")
    else:
        print(f"FAIL: HTTP {response.status_code}: {response.text}")
except TypeError as e:
    if "issubclass" in str(e):
        print(f"FAIL: TypeError still raised: {e}")
    else:
        print(f"FAIL: Unexpected TypeError: {e}")
except Exception as e:
    print(f"FAIL: Unexpected error: {type(e).__name__}: {e}")

# Test 3: Same endpoint returns valid response with no files
try:
    response = client.post("/files")
    if response.status_code == 200:
        data = response.json()
        if data.get("files_count") == 0:
            passed += 1
            print("PASS: No-file request returns files_count=0")
        else:
            print(f"FAIL: Unexpected response data: {data}")
    elif response.status_code == 422:
        # 422 is acceptable if the endpoint requires files — but we set default=None
        print(f"FAIL: Got 422 validation error when no files sent")
    else:
        print(f"FAIL: HTTP {response.status_code}: {response.text}")
except Exception as e:
    print(f"FAIL: Unexpected error: {type(e).__name__}: {e}")

print(json.dumps({"passed": passed, "total": total}))
PYEOF
