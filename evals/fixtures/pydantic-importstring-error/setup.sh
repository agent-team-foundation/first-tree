#!/usr/bin/env bash
set -euo pipefail

uv venv .venv --quiet
uv sync --frozen --all-groups --all-packages --all-extras --quiet --python .venv/bin/python 2>/dev/null || uv pip install -e ".[testing]" --quiet --python .venv/bin/python
