#!/usr/bin/env bash
set -euo pipefail

cd python/packages/autogen-core
uv venv .venv --quiet
uv pip install -e ".[dev]" --quiet --python .venv/bin/python 2>/dev/null || uv pip install -e "." --quiet --python .venv/bin/python
uv pip install -e ../autogen-test-utils --quiet --python .venv/bin/python 2>/dev/null || true
uv pip install pytest-asyncio --quiet --python .venv/bin/python 2>/dev/null || true
