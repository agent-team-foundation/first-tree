#!/usr/bin/env bash
set -euo pipefail

# Legacy wrapper — mirrors are now symlinks, so there is nothing to sync.
# Kept for backwards compatibility with documentation that references this script.
echo "Nothing to sync — .agents/ and .claude/ skill directories are symlinks to skills/."
