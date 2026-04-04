#!/usr/bin/env bash
set -euo pipefail

cd llama-index-core
uv venv .venv --quiet
uv pip install -e . --quiet --python .venv/bin/python
uv pip install pytest pytest-asyncio --quiet --python .venv/bin/python
