#!/usr/bin/env bash
set -euo pipefail

# Legacy wrapper — mirrors are now symlinks, so there is nothing to export.
echo "Nothing to export — .agents/ and .claude/ skill directories are symlinks to skills/."
