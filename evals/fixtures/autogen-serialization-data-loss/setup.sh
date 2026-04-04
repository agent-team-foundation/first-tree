#!/usr/bin/env bash
set -euo pipefail

cd python/packages/autogen-agentchat

uv venv .venv --quiet
uv pip install -e ".[dev]" --quiet --python .venv/bin/python 2>/dev/null || uv pip install -e "." --quiet --python .venv/bin/python
