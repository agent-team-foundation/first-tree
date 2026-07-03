#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DEFAULT_DOWNLOAD_BASE_URL="https://downloads.first-tree.ai"

CHANNEL=""
VERSION=""
DOWNLOAD_BASE_URL="${FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL:-$DEFAULT_DOWNLOAD_BASE_URL}"
DRY_RUN=0
BUILD_ARGS=()
UPLOAD_ARGS=()

log() {
  printf '[portable release] %s\n' "$*"
}

die() {
  printf '[portable release] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/portable/release-s3.sh --channel prod|staging --version <version> [options]

Builds portable artifacts, uploads them to S3-compatible storage, then runs a
public install smoke test unless --dry-run is set.

Options:
  --download-base-url <url>     Public release base URL, without prod/staging.
  --out-dir <dir>               Output directory for build and upload.
  --platform <platform>         Repeatable platform filter.
  --node-version <version>      Node runtime version.
  --skip-workspace-build        Reuse an existing apps/cli/dist build.
  --bucket <bucket>             S3 bucket name.
  --prefix <prefix>             S3 key prefix before prod/staging.
  --endpoint-url <url>          S3-compatible endpoint URL.
  --region <region>             AWS region.
  --profile <profile>           AWS profile for local credentials.
  --dry-run                     Dry-run upload and skip remote install smoke.
  --help                        Show this help.
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

export_aws_credentials_from_portable_env() {
  if [[ -z "${AWS_ACCESS_KEY_ID:-}" && -n "${FIRST_TREE_PORTABLE_S3_ACCESS_KEY_ID:-}" ]]; then
    export AWS_ACCESS_KEY_ID="$FIRST_TREE_PORTABLE_S3_ACCESS_KEY_ID"
  fi
  if [[ -z "${AWS_SECRET_ACCESS_KEY:-}" && -n "${FIRST_TREE_PORTABLE_S3_SECRET_ACCESS_KEY:-}" ]]; then
    export AWS_SECRET_ACCESS_KEY="$FIRST_TREE_PORTABLE_S3_SECRET_ACCESS_KEY"
  fi
  if [[ -z "${AWS_SESSION_TOKEN:-}" && -n "${FIRST_TREE_PORTABLE_S3_SESSION_TOKEN:-}" ]]; then
    export AWS_SESSION_TOKEN="$FIRST_TREE_PORTABLE_S3_SESSION_TOKEN"
  fi
}

remote_install_smoke() {
  [[ "$CHANNEL" == "prod" || "$CHANNEL" == "staging" ]] || die "--channel must be prod or staging"
  [[ -n "$VERSION" ]] || die "--version is required"
  command -v curl >/dev/null 2>&1 || die "curl is required for remote install smoke"

  local bin_name
  if [[ "$CHANNEL" == "prod" ]]; then
    bin_name="first-tree"
  else
    bin_name="first-tree-staging"
  fi

  (
    set -euo pipefail
    tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/first-tree-portable-install.XXXXXX")"
    trap 'rm -rf "$tmp_dir"' EXIT

    local installer="$tmp_dir/install.sh"
    local installer_url="$DOWNLOAD_BASE_URL/$CHANNEL/install.sh"
    log "running remote install smoke from $installer_url"
    curl -fsSL --retry 3 --retry-delay 2 "$installer_url" -o "$installer"
    chmod +x "$installer"

    FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL="$DOWNLOAD_BASE_URL" \
      FIRST_TREE_PORTABLE_CHANNEL="$CHANNEL" \
      sh "$installer" --prefix "$tmp_dir/prefix" --bin-dir "$tmp_dir/bin" --no-path-edit

    local version_output
    version_output="$("$tmp_dir/bin/$bin_name" --version 2>&1)"
    if [[ "$version_output" != *"$VERSION"* ]]; then
      die "remote install smoke expected version $VERSION, got: $version_output"
    fi
    log "remote install smoke passed: $version_output"
  )
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel)
      require_value "$1" "${2:-}"
      CHANNEL="$2"
      BUILD_ARGS+=("$1" "$2")
      UPLOAD_ARGS+=("$1" "$2")
      shift 2
      ;;
    --version)
      require_value "$1" "${2:-}"
      VERSION="$2"
      BUILD_ARGS+=("$1" "$2")
      shift 2
      ;;
    --download-base-url)
      require_value "$1" "${2:-}"
      DOWNLOAD_BASE_URL="$2"
      BUILD_ARGS+=("$1" "$2")
      UPLOAD_ARGS+=("$1" "$2")
      shift 2
      ;;
    --out-dir)
      require_value "$1" "${2:-}"
      BUILD_ARGS+=("$1" "$2")
      UPLOAD_ARGS+=("$1" "$2")
      shift 2
      ;;
    --platform|--node-version|--skip-workspace-build)
      if [[ "$1" == "--skip-workspace-build" ]]; then
        BUILD_ARGS+=("$1")
        shift
      else
        require_value "$1" "${2:-}"
        BUILD_ARGS+=("$1" "$2")
        shift 2
      fi
      ;;
    --bucket|--endpoint-url|--region|--profile)
      require_value "$1" "${2:-}"
      UPLOAD_ARGS+=("$1" "$2")
      shift 2
      ;;
    --prefix)
      if [[ $# -lt 2 ]]; then
        die "--prefix requires a value"
      fi
      UPLOAD_ARGS+=("$1" "$2")
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      UPLOAD_ARGS+=("$1")
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
validate_download_base_url "$DOWNLOAD_BASE_URL"
export_aws_credentials_from_portable_env

"$SCRIPT_DIR/build-release.sh" "${BUILD_ARGS[@]}"
"$SCRIPT_DIR/upload-s3.sh" "${UPLOAD_ARGS[@]}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "dry run completed; skipping remote install smoke"
else
  remote_install_smoke
fi
