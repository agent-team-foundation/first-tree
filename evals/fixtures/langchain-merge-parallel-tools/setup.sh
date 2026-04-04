#!/usr/bin/env bash
set -euo pipefail

cd libs/core
uv venv .venv --quiet
uv pip install -e ".[test]" --quiet --python .venv/bin/python
