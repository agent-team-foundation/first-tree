#!/usr/bin/env bash
set -euo pipefail

uv venv .venv --quiet
uv pip install -e ".[all]" --quiet --python .venv/bin/python
uv pip install pytest httpx python-multipart --quiet --python .venv/bin/python
