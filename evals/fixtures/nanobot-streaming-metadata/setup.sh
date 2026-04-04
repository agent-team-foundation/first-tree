#!/usr/bin/env bash
set -euo pipefail

uv venv .venv --quiet
uv pip install -e ".[dev]" --quiet --python .venv/bin/python
