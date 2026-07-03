#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

IMMUTABLE_CACHE_CONTROL="public, max-age=31536000, immutable"
MUTABLE_CACHE_CONTROL="no-cache"
DEFAULT_OUT_DIR=".portable-release"
DEFAULT_REGION="us-east-1"

CHANNEL=""
OUT_DIR="${FIRST_TREE_PORTABLE_OUT_DIR:-$DEFAULT_OUT_DIR}"
BUCKET="${FIRST_TREE_PORTABLE_S3_BUCKET:-}"
PREFIX="${FIRST_TREE_PORTABLE_S3_PREFIX:-}"
ENDPOINT_URL="${FIRST_TREE_PORTABLE_S3_ENDPOINT_URL:-}"
REGION="${FIRST_TREE_PORTABLE_S3_REGION:-$DEFAULT_REGION}"
PROFILE="${FIRST_TREE_PORTABLE_S3_PROFILE:-}"
DOWNLOAD_BASE_URL="${FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL:-}"
DRY_RUN=0

log() {
  printf '[portable upload] %s\n' "$*"
}

die() {
  printf '[portable upload] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/portable/upload-s3.sh --channel prod|staging [options]

Options:
  --out-dir <dir>               Portable release output directory.
  --bucket <bucket>             S3 bucket name.
  --prefix <prefix>             S3 key prefix before prod/staging.
  --endpoint-url <url>          S3-compatible endpoint URL.
  --region <region>             AWS region. Defaults to us-east-1.
  --profile <profile>           AWS profile for local credentials.
  --download-base-url <url>     Public release base URL, without prod/staging.
  --dry-run                     Pass --dryrun to aws and skip public URL checks.
  --help                        Show this help.

Environment:
  FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL
  FIRST_TREE_PORTABLE_S3_BUCKET
  FIRST_TREE_PORTABLE_S3_PREFIX
  FIRST_TREE_PORTABLE_S3_ENDPOINT_URL
  FIRST_TREE_PORTABLE_S3_REGION
  FIRST_TREE_PORTABLE_S3_PROFILE
  FIRST_TREE_PORTABLE_S3_ACCESS_KEY_ID
  FIRST_TREE_PORTABLE_S3_SECRET_ACCESS_KEY
  FIRST_TREE_PORTABLE_S3_SESSION_TOKEN
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

normalize_prefix() {
  local value="$1"
  while [[ "$value" == /* ]]; do
    value="${value#/}"
  done
  while [[ "$value" == */ ]]; do
    value="${value%/}"
  done
  printf '%s' "$value"
}

validate_channel() {
  [[ "$CHANNEL" == "prod" || "$CHANNEL" == "staging" ]] || die "--channel must be prod or staging"
}

validate_download_base_url() {
  local value="$1"
  [[ -n "$value" ]] || die "download base URL is required for public verification"
  local trimmed
  trimmed="$(trim_trailing_slashes "$value")"
  local last_segment="${trimmed##*/}"
  if [[ "$last_segment" == "prod" || "$last_segment" == "staging" ]]; then
    die "--download-base-url must not include the channel segment; got $value"
  fi
  DOWNLOAD_BASE_URL="$trimmed"
}

json_string() {
  local file="$1"
  local path="$2"
  node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
let value = data;
for (const key of process.argv[2].split(".")) value = value?.[key];
if (typeof value !== "string") process.exit(2);
process.stdout.write(value);
' "$file" "$path"
}

asset_files() {
  local manifest="$1"
  node -e '
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const asset of manifest.assets ?? []) {
  if (typeof asset.fileName === "string") console.log(asset.fileName);
}
' "$manifest"
}

first_asset_url() {
  local manifest="$1"
  node -e '
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const url = manifest.assets?.[0]?.url;
if (typeof url !== "string") process.exit(2);
process.stdout.write(url);
' "$manifest"
}

derive_download_base_url() {
  local latest="$1"
  local channel="$2"
  local version="$3"
  node -e '
const fs = require("node:fs");
const latest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const channel = process.argv[2];
const version = process.argv[3];
const manifestUrl = latest.manifestUrl;
if (typeof manifestUrl !== "string") process.exit(2);
const suffix = `/${channel}/${version}/manifest.json`;
if (!manifestUrl.endsWith(suffix)) {
  throw new Error(`manifestUrl must end with ${suffix}: ${manifestUrl}`);
}
process.stdout.write(manifestUrl.slice(0, -suffix.length));
' "$latest" "$channel" "$version"
}

s3_uri() {
  local key="$1"
  if [[ -n "$PREFIX" ]]; then
    printf 's3://%s/%s/%s' "$BUCKET" "$PREFIX" "$key"
  else
    printf 's3://%s/%s' "$BUCKET" "$key"
  fi
}

aws_args() {
  AWS_ARGS=()
  [[ -n "$REGION" ]] && AWS_ARGS+=(--region "$REGION")
  [[ -n "$ENDPOINT_URL" ]] && AWS_ARGS+=(--endpoint-url "$ENDPOINT_URL")
  [[ -n "$PROFILE" ]] && AWS_ARGS+=(--profile "$PROFILE")
  return 0
}

run_aws() {
  aws_args
  aws "${AWS_ARGS[@]}" "$@"
}

run_aws_maybe_dryrun() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    run_aws "$@" --dryrun
  else
    run_aws "$@"
  fi
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

download_url() {
  local url="$1"
  local dest="$2"
  curl -fsSL --retry 3 --retry-delay 2 "$url" -o "$dest"
}

check_tarball_url() {
  local url="$1"
  if curl -fsSI --retry 3 --retry-delay 2 "$url" >/dev/null; then
    return 0
  fi
  curl -fsSL --retry 3 --retry-delay 2 -r 0-0 "$url" -o /dev/null
}

verify_remote_release() {
  local version="$1"
  (
    set -euo pipefail
    tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/first-tree-portable-remote.XXXXXX")"
    trap 'rm -rf "$tmp_dir"' EXIT

    local latest_url="$DOWNLOAD_BASE_URL/$CHANNEL/latest.json"
    local latest_path="$tmp_dir/latest.json"
    log "verifying public latest metadata: $latest_url"
    download_url "$latest_url" "$latest_path"

    local remote_channel
    local remote_version
    remote_channel="$(json_string "$latest_path" "channel")"
    remote_version="$(json_string "$latest_path" "version")"
    [[ "$remote_channel" == "$CHANNEL" ]] || die "remote latest channel mismatch: expected $CHANNEL, got $remote_channel"
    [[ "$remote_version" == "$version" ]] || die "remote latest version mismatch: expected $version, got $remote_version"

    local manifest_url
    manifest_url="$(json_string "$latest_path" "manifestUrl")"
    local manifest_path="$tmp_dir/manifest.json"
    log "verifying public manifest metadata: $manifest_url"
    download_url "$manifest_url" "$manifest_path"
    remote_channel="$(json_string "$manifest_path" "channel")"
    remote_version="$(json_string "$manifest_path" "version")"
    [[ "$remote_channel" == "$CHANNEL" ]] || die "remote manifest channel mismatch: expected $CHANNEL, got $remote_channel"
    [[ "$remote_version" == "$version" ]] || die "remote manifest version mismatch: expected $version, got $remote_version"

    local tarball_url
    tarball_url="$(first_asset_url "$manifest_path")"
    log "verifying public tarball URL: $tarball_url"
    check_tarball_url "$tarball_url"
  )
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel)
      require_value "$1" "${2:-}"
      CHANNEL="$2"
      shift 2
      ;;
    --out-dir)
      require_value "$1" "${2:-}"
      OUT_DIR="$2"
      shift 2
      ;;
    --bucket)
      require_value "$1" "${2:-}"
      BUCKET="$2"
      shift 2
      ;;
    --prefix)
      if [[ $# -lt 2 ]]; then
        die "--prefix requires a value"
      fi
      PREFIX="$2"
      shift 2
      ;;
    --endpoint-url)
      require_value "$1" "${2:-}"
      ENDPOINT_URL="$2"
      shift 2
      ;;
    --region)
      require_value "$1" "${2:-}"
      REGION="$2"
      shift 2
      ;;
    --profile)
      require_value "$1" "${2:-}"
      PROFILE="$2"
      shift 2
      ;;
    --download-base-url)
      require_value "$1" "${2:-}"
      DOWNLOAD_BASE_URL="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
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

validate_channel
[[ -n "$BUCKET" ]] || die "--bucket or FIRST_TREE_PORTABLE_S3_BUCKET is required"
PREFIX="$(normalize_prefix "$PREFIX")"
if [[ -n "$PREFIX" ]]; then
  prefix_last_segment="${PREFIX##*/}"
  if [[ "$prefix_last_segment" == "prod" || "$prefix_last_segment" == "staging" ]]; then
    die "--prefix must not include the channel segment; got $PREFIX"
  fi
fi

if ! command -v aws >/dev/null 2>&1; then
  die "aws CLI is required"
fi
if [[ "$DRY_RUN" -eq 0 ]] && ! command -v curl >/dev/null 2>&1; then
  die "curl is required for public release verification"
fi

if [[ "$OUT_DIR" == /* ]]; then
  CHANNEL_DIR="$OUT_DIR/$CHANNEL"
else
  CHANNEL_DIR="$REPO_ROOT/$OUT_DIR/$CHANNEL"
fi
LATEST_PATH="$CHANNEL_DIR/latest.json"
INSTALLER_PATH="$CHANNEL_DIR/install.sh"
[[ -f "$LATEST_PATH" ]] || die "missing latest metadata: $LATEST_PATH"
[[ -f "$INSTALLER_PATH" ]] || die "missing installer: $INSTALLER_PATH"

LOCAL_CHANNEL="$(json_string "$LATEST_PATH" "channel")"
VERSION="$(json_string "$LATEST_PATH" "version")"
[[ "$LOCAL_CHANNEL" == "$CHANNEL" ]] || die "local latest channel mismatch: expected $CHANNEL, got $LOCAL_CHANNEL"
VERSION_DIR="$CHANNEL_DIR/$VERSION"
MANIFEST_PATH="$VERSION_DIR/manifest.json"
[[ -d "$VERSION_DIR" ]] || die "missing version directory: $VERSION_DIR"
[[ -f "$MANIFEST_PATH" ]] || die "missing manifest: $MANIFEST_PATH"

MANIFEST_CHANNEL="$(json_string "$MANIFEST_PATH" "channel")"
MANIFEST_VERSION="$(json_string "$MANIFEST_PATH" "version")"
[[ "$MANIFEST_CHANNEL" == "$CHANNEL" ]] || die "local manifest channel mismatch: expected $CHANNEL, got $MANIFEST_CHANNEL"
[[ "$MANIFEST_VERSION" == "$VERSION" ]] || die "local manifest version mismatch: expected $VERSION, got $MANIFEST_VERSION"

while IFS= read -r file_name; do
  [[ -f "$VERSION_DIR/$file_name" ]] || die "manifest asset is missing from version directory: $file_name"
done < <(asset_files "$MANIFEST_PATH")

if [[ -z "$DOWNLOAD_BASE_URL" ]]; then
  DOWNLOAD_BASE_URL="$(derive_download_base_url "$LATEST_PATH" "$CHANNEL" "$VERSION")"
fi
validate_download_base_url "$DOWNLOAD_BASE_URL"
export_aws_credentials_from_portable_env

VERSION_S3_URI="$(s3_uri "$CHANNEL/$VERSION")/"
CHANNEL_S3_URI="$(s3_uri "$CHANNEL")"

log "uploading immutable version files to $VERSION_S3_URI"
run_aws_maybe_dryrun s3 sync "$VERSION_DIR/" "$VERSION_S3_URI" \
  --cache-control "$IMMUTABLE_CACHE_CONTROL"

log "uploading mutable latest.json to $CHANNEL_S3_URI/latest.json"
run_aws_maybe_dryrun s3 cp "$LATEST_PATH" "$CHANNEL_S3_URI/latest.json" \
  --cache-control "$MUTABLE_CACHE_CONTROL" \
  --content-type "application/json"

log "uploading mutable install.sh to $CHANNEL_S3_URI/install.sh"
run_aws_maybe_dryrun s3 cp "$INSTALLER_PATH" "$CHANNEL_S3_URI/install.sh" \
  --cache-control "$MUTABLE_CACHE_CONTROL" \
  --content-type "text/x-shellscript; charset=utf-8"

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "dry run completed; skipping public URL verification"
else
  verify_remote_release "$VERSION"
fi
