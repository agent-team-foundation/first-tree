#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "$SCRIPT_DIR/export-runtime-assets.sh"
bash "$SCRIPT_DIR/sync-portable-snapshot.sh"
bash "$SCRIPT_DIR/export-skill-mirrors.sh"
