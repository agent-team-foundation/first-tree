#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DEFAULT_PLATFORMS=("darwin-arm64" "darwin-x64" "linux-arm64" "linux-x64")
DEFAULT_NODE_VERSION="latest-v24.x"
DEFAULT_OUT_DIR=".portable-release"
DEFAULT_DOWNLOAD_BASE_URL="https://download.first-tree.ai/releases"

CHANNEL=""
VERSION=""
DOWNLOAD_BASE_URL="${FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL:-$DEFAULT_DOWNLOAD_BASE_URL}"
OUT_DIR="${FIRST_TREE_PORTABLE_OUT_DIR:-$DEFAULT_OUT_DIR}"
NODE_VERSION="${FIRST_TREE_PORTABLE_NODE_VERSION:-$DEFAULT_NODE_VERSION}"
GENERATED_AT="${FIRST_TREE_PORTABLE_GENERATED_AT:-}"
SKIP_WORKSPACE_BUILD=0
PLATFORMS=()

log() {
  printf '[portable release] %s\n' "$*"
}

die() {
  printf '[portable release] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/portable/build-release.sh --channel prod|staging --version <version> [options]

Options:
  --download-base-url <url>     Public release base URL, without prod/staging.
  --out-dir <dir>               Output directory. Defaults to FIRST_TREE_PORTABLE_OUT_DIR or .portable-release.
  --platform <platform>         Repeatable platform filter.
  --node-version <version>      Node runtime version. Defaults to FIRST_TREE_PORTABLE_NODE_VERSION or latest-v24.x.
  --generated-at <timestamp>    Release generation timestamp. Defaults to the current git commit timestamp.
  --skip-workspace-build        Reuse an existing apps/cli/dist build.
  --help                        Show this help.

Environment:
  FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL
  FIRST_TREE_PORTABLE_PLATFORMS
  FIRST_TREE_PORTABLE_NODE_VERSION
  FIRST_TREE_PORTABLE_GENERATED_AT
  FIRST_TREE_PORTABLE_OUT_DIR
EOF
}

require_value() {
  local name="$1"
  local value="${2:-}"
  [[ -n "$value" && "$value" != --* ]] || die "$name requires a value"
}

trim_trailing_slashes() {
  local value="$1"
  while [[ "$value" == */ ]]; do
    value="${value%/}"
  done
  printf '%s' "$value"
}

validate_download_base_url() {
  local value="$1"
  [[ -n "$value" ]] || die "--download-base-url is required"
  local trimmed
  trimmed="$(trim_trailing_slashes "$value")"
  local last_segment="${trimmed##*/}"
  if [[ "$last_segment" == "prod" || "$last_segment" == "staging" ]]; then
    die "--download-base-url must not include the channel segment; got $value"
  fi
  DOWNLOAD_BASE_URL="$trimmed"
}

validate_channel_version() {
  case "$CHANNEL" in
    prod)
      [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
        die "prod releases require a stable X.Y.Z semver version, got $VERSION"
      ;;
    staging)
      [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-staging\.[0-9A-Za-z.-]+$ ]] ||
        die "staging releases require an X.Y.Z-staging.* version, got $VERSION"
      ;;
    *)
      die "--channel must be prod or staging"
      ;;
  esac
}

split_platforms() {
  local raw="$1"
  raw="${raw//,/ }"
  # shellcheck disable=SC2206
  local values=($raw)
  local platform
  for platform in "${values[@]}"; do
    [[ -n "$platform" ]] && PLATFORMS+=("$platform")
  done
}

run_workspace_build() {
  log "building workspace packages"
  (cd "$REPO_ROOT" && pnpm --filter @first-tree/shared build)
  (cd "$REPO_ROOT" && pnpm --filter @first-tree/client build)
  (cd "$REPO_ROOT" && pnpm --filter first-tree-dev build)
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel)
      require_value "$1" "${2:-}"
      CHANNEL="$2"
      shift 2
      ;;
    --version)
      require_value "$1" "${2:-}"
      VERSION="$2"
      shift 2
      ;;
    --download-base-url)
      require_value "$1" "${2:-}"
      DOWNLOAD_BASE_URL="$2"
      shift 2
      ;;
    --out-dir)
      require_value "$1" "${2:-}"
      OUT_DIR="$2"
      shift 2
      ;;
    --platform)
      require_value "$1" "${2:-}"
      PLATFORMS+=("$2")
      shift 2
      ;;
    --node-version)
      require_value "$1" "${2:-}"
      NODE_VERSION="$2"
      shift 2
      ;;
    --generated-at)
      require_value "$1" "${2:-}"
      GENERATED_AT="$2"
      shift 2
      ;;
    --skip-workspace-build)
      SKIP_WORKSPACE_BUILD=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ -n "$CHANNEL" ]] || die "--channel is required"
[[ -n "$VERSION" ]] || die "--version is required"
validate_channel_version
validate_download_base_url "$DOWNLOAD_BASE_URL"

if [[ ${#PLATFORMS[@]} -eq 0 && -n "${FIRST_TREE_PORTABLE_PLATFORMS:-}" ]]; then
  split_platforms "$FIRST_TREE_PORTABLE_PLATFORMS"
fi
if [[ ${#PLATFORMS[@]} -eq 0 ]]; then
  PLATFORMS=("${DEFAULT_PLATFORMS[@]}")
fi

if [[ "$SKIP_WORKSPACE_BUILD" -eq 0 ]]; then
  run_workspace_build
else
  log "skipping workspace build"
fi

GIT_SHA="$(cd "$REPO_ROOT" && git rev-parse HEAD)"
if [[ -z "$GENERATED_AT" ]]; then
  GENERATED_AT="$(cd "$REPO_ROOT" && git show -s --format=%cI HEAD)"
fi
ARGS=(
  "$SCRIPT_DIR/build-portable.mjs"
  --channel "$CHANNEL"
  --version "$VERSION"
  --git-sha "$GIT_SHA"
  --node-version "$NODE_VERSION"
  --download-base-url "$DOWNLOAD_BASE_URL"
  --generated-at "$GENERATED_AT"
  --out-dir "$OUT_DIR"
)

for platform in "${PLATFORMS[@]}"; do
  ARGS+=(--platform "$platform")
done

log "building $CHANNEL $VERSION portable artifacts into $OUT_DIR"
(cd "$REPO_ROOT" && node "${ARGS[@]}")
