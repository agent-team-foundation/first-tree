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
PREFLIGHT_ONLY=0

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
  --preflight-only              Check immutable prefix compatibility without writing objects.
  --dry-run                     Exercise upload commands with aws s3 cp --dryrun and skip remote checks.
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

asset_entries() {
  local manifest="$1"
  node -e '
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const asset of manifest.assets ?? []) {
  if (typeof asset.fileName !== "string" || typeof asset.url !== "string") process.exit(2);
  console.log(`${asset.fileName}\t${asset.url}`);
}
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

s3_key() {
  local key="$1"
  if [[ -n "$PREFIX" ]]; then
    printf '%s/%s' "$PREFIX" "$key"
  else
    printf '%s' "$key"
  fi
}

sha256_file() {
  local file="$1"
  node -e '
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"));
' "$file"
}

file_size() {
  local file="$1"
  node -e '
const { statSync } = require("node:fs");
process.stdout.write(String(statSync(process.argv[1]).size));
' "$file"
}

content_type_for_file() {
  local file_name="$1"
  case "$file_name" in
    manifest.json|latest.json)
      printf 'application/json'
      ;;
    SHA256SUMS)
      printf 'text/plain; charset=utf-8'
      ;;
    *.tar.gz)
      printf 'application/gzip'
      ;;
    *.sh)
      printf 'text/x-shellscript; charset=utf-8'
      ;;
    *)
      printf 'application/octet-stream'
      ;;
  esac
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

# The channel entry points (latest.json / install.sh) are the only mutable
# objects, and flipping them publishes the release to every installer and
# self-update client. They must therefore only be updated after the public
# download endpoint has proven it can serve the complete versioned release,
# and all expected URLs are derived from the local release metadata rather
# than from anything already remote.
verify_public_file_matches() {
  local label="$1"
  local url="$2"
  local local_path="$3"
  local dest="$4"
  log "verifying public $label: $url"
  download_url "$url" "$dest" || die "public $label is not readable: $url"
  cmp -s -- "$local_path" "$dest" || die "public $label does not match the local release artifact: $url"
}

validate_local_release_urls() {
  local expected_manifest_url="$DOWNLOAD_BASE_URL/$CHANNEL/$VERSION/manifest.json"
  local local_manifest_url
  local_manifest_url="$(json_string "$LATEST_PATH" "manifestUrl")"
  if [[ "$local_manifest_url" != "$expected_manifest_url" ]]; then
    die "local latest.json manifestUrl mismatch: expected $expected_manifest_url, got $local_manifest_url (build and upload must use the same download base URL)"
  fi
  local file_name
  local url
  while IFS=$'\t' read -r file_name url; do
    [[ -n "$file_name" ]] || continue
    if [[ "$url" != "$DOWNLOAD_BASE_URL/$CHANNEL/$VERSION/$file_name" ]]; then
      die "manifest asset url mismatch for $file_name: expected $DOWNLOAD_BASE_URL/$CHANNEL/$VERSION/$file_name, got $url"
    fi
  done < <(asset_entries "$MANIFEST_PATH")
}

verify_remote_versioned_release() {
  (
    set -euo pipefail
    tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/first-tree-portable-remote.XXXXXX")"
    trap 'rm -rf "$tmp_dir"' EXIT

    local version_base_url="$DOWNLOAD_BASE_URL/$CHANNEL/$VERSION"
    verify_public_file_matches "versioned manifest" "$version_base_url/manifest.json" "$MANIFEST_PATH" "$tmp_dir/manifest.json"
    verify_public_file_matches "versioned SHA256SUMS" "$version_base_url/SHA256SUMS" "$VERSION_DIR/SHA256SUMS" "$tmp_dir/SHA256SUMS"

    local file_name
    local url
    while IFS=$'\t' read -r file_name url; do
      [[ -n "$file_name" ]] || continue
      log "verifying public release asset: $url"
      check_tarball_url "$url" || die "public release asset is not readable: $url"
    done < <(asset_entries "$MANIFEST_PATH")
  )
}

verify_remote_channel_pointers() {
  (
    set -euo pipefail
    tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/first-tree-portable-remote.XXXXXX")"
    trap 'rm -rf "$tmp_dir"' EXIT

    verify_public_file_matches "channel latest.json" "$DOWNLOAD_BASE_URL/$CHANNEL/latest.json" "$LATEST_PATH" "$tmp_dir/latest.json"
    verify_public_file_matches "channel install.sh" "$DOWNLOAD_BASE_URL/$CHANNEL/install.sh" "$INSTALLER_PATH" "$tmp_dir/install.sh"
  )
}

write_expected_objects() {
  local output_path="$1"
  : > "$output_path"

  local file_name
  for file_name in manifest.json SHA256SUMS; do
    local local_path="$VERSION_DIR/$file_name"
    [[ -f "$local_path" ]] || die "missing immutable release object: $local_path"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$file_name" \
      "$local_path" \
      "$(sha256_file "$local_path")" \
      "$(file_size "$local_path")" \
      "$(content_type_for_file "$file_name")" \
      "$(s3_key "$CHANNEL/$VERSION/$file_name")" >> "$output_path"
  done

  while IFS= read -r file_name; do
    [[ -n "$file_name" ]] || continue
    if [[ "$file_name" == */* || "$file_name" == "." || "$file_name" == ".." || "$file_name" == *$'\t'* ]]; then
      die "manifest asset fileName must be a simple file name, got: $file_name"
    fi
    local local_path="$VERSION_DIR/$file_name"
    [[ -f "$local_path" ]] || die "manifest asset is missing from version directory: $file_name"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$file_name" \
      "$local_path" \
      "$(sha256_file "$local_path")" \
      "$(file_size "$local_path")" \
      "$(content_type_for_file "$file_name")" \
      "$(s3_key "$CHANNEL/$VERSION/$file_name")" >> "$output_path"
  done < <(asset_files "$MANIFEST_PATH")
}

write_expected_keys() {
  local expected_objects_path="$1"
  local expected_keys_path="$2"
  awk -F '\t' '{ print $6 }' "$expected_objects_path" > "$expected_keys_path"
}

list_remote_version_keys() {
  local output_path="$1"
  local version_prefix
  version_prefix="$(s3_key "$CHANNEL/$VERSION/")"
  run_aws s3api list-objects-v2 \
    --bucket "$BUCKET" \
    --prefix "$version_prefix" \
    --output json |
    node -e '
const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8").trim();
const data = input ? JSON.parse(input) : {};
const contents = Array.isArray(data.Contents) ? data.Contents : [];
for (const item of contents) {
  if (typeof item?.Key === "string") console.log(item.Key);
}
' > "$output_path"
}

remote_key_exists() {
  local key="$1"
  local remote_keys_path="$2"
  grep -Fxq -- "$key" "$remote_keys_path"
}

validate_no_extra_remote_objects() {
  local remote_keys_path="$1"
  local expected_keys_path="$2"
  local key
  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    if ! grep -Fxq -- "$key" "$expected_keys_path"; then
      die "remote version prefix contains unexpected object: $key"
    fi
  done < "$remote_keys_path"
}

read_head_field() {
  local head_json="$1"
  local field="$2"
  node -e '
const data = JSON.parse(process.argv[1]);
const field = process.argv[2];
if (field === "size") {
  const value = data.ContentLength;
  if (typeof value !== "number") process.exit(2);
  process.stdout.write(String(value));
} else if (field === "sha256") {
  const metadata = data.Metadata && typeof data.Metadata === "object" ? data.Metadata : {};
  const value = metadata.sha256 ?? metadata.SHA256 ?? metadata.Sha256;
  if (typeof value !== "string") process.exit(2);
  process.stdout.write(value);
} else {
  process.exit(2);
}
' "$head_json" "$field"
}

check_remote_object_matches() {
  local key="$1"
  local expected_size="$2"
  local expected_sha="$3"
  local head_json
  head_json="$(run_aws s3api head-object --bucket "$BUCKET" --key "$key" --output json)"
  local remote_size
  local remote_sha
  remote_size="$(read_head_field "$head_json" "size" || true)"
  remote_sha="$(read_head_field "$head_json" "sha256" || true)"
  if [[ "$remote_size" != "$expected_size" ]]; then
    die "remote immutable object size mismatch for $key: expected $expected_size, got ${remote_size:-missing}"
  fi
  if [[ "$remote_sha" != "$expected_sha" ]]; then
    die "remote immutable object sha256 metadata mismatch for $key: expected $expected_sha, got ${remote_sha:-missing}"
  fi
}

check_remote_immutable_prefix() {
  local mode="$1"
  local expected_objects_path="$2"
  local missing_objects_path="$3"
  local remote_keys_path
  local expected_keys_path
  remote_keys_path="$(mktemp "${TMPDIR:-/tmp}/first-tree-s3-remote-keys.XXXXXX")"
  expected_keys_path="$(mktemp "${TMPDIR:-/tmp}/first-tree-s3-expected-keys.XXXXXX")"

  write_expected_keys "$expected_objects_path" "$expected_keys_path"
  list_remote_version_keys "$remote_keys_path"
  validate_no_extra_remote_objects "$remote_keys_path" "$expected_keys_path"
  : > "$missing_objects_path"

  local file_name
  local local_path
  local expected_sha
  local expected_size
  local content_type
  local key
  while IFS=$'\t' read -r file_name local_path expected_sha expected_size content_type key; do
    [[ -n "$file_name" ]] || continue
    if remote_key_exists "$key" "$remote_keys_path"; then
      check_remote_object_matches "$key" "$expected_size" "$expected_sha"
    elif [[ "$mode" == "require-complete" ]]; then
      die "remote immutable object is missing after upload: $key"
    else
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$file_name" "$local_path" "$expected_sha" "$expected_size" "$content_type" "$key" >> "$missing_objects_path"
    fi
  done < "$expected_objects_path"
  rm -f "$remote_keys_path" "$expected_keys_path"
}

upload_immutable_object() {
  local file_name="$1"
  local local_path="$2"
  local expected_sha="$3"
  local content_type="$4"
  local key="$5"
  log "uploading immutable object: $key"
  run_aws s3api put-object \
    --bucket "$BUCKET" \
    --key "$key" \
    --body "$local_path" \
    --cache-control "$IMMUTABLE_CACHE_CONTROL" \
    --content-type "$content_type" \
    --metadata "sha256=$expected_sha" \
    --if-none-match "*"
}

upload_mutable_object() {
  local label="$1"
  local local_path="$2"
  local content_type="$3"
  local key="$4"
  local expected_sha
  expected_sha="$(sha256_file "$local_path")"
  log "uploading mutable $label to $(s3_uri "$key")"
  run_aws s3api put-object \
    --bucket "$BUCKET" \
    --key "$(s3_key "$key")" \
    --body "$local_path" \
    --cache-control "$MUTABLE_CACHE_CONTROL" \
    --content-type "$content_type" \
    --metadata "sha256=$expected_sha"
}

dry_run_uploads() {
  local expected_objects_path="$1"
  local file_name
  local local_path
  local expected_sha
  local expected_size
  local content_type
  local key
  while IFS=$'\t' read -r file_name local_path expected_sha expected_size content_type key; do
    [[ -n "$file_name" ]] || continue
    log "dry-run immutable object upload: $key"
    run_aws s3 cp "$local_path" "$(s3_uri "$CHANNEL/$VERSION/$file_name")" \
      --cache-control "$IMMUTABLE_CACHE_CONTROL" \
      --content-type "$content_type" \
      --metadata "sha256=$expected_sha" \
      --dryrun
  done < "$expected_objects_path"

  log "dry-run mutable latest.json upload"
  run_aws s3 cp "$LATEST_PATH" "$(s3_uri "$CHANNEL/latest.json")" \
    --cache-control "$MUTABLE_CACHE_CONTROL" \
    --content-type "application/json" \
    --metadata "sha256=$(sha256_file "$LATEST_PATH")" \
    --dryrun

  log "dry-run mutable install.sh upload"
  run_aws s3 cp "$INSTALLER_PATH" "$(s3_uri "$CHANNEL/install.sh")" \
    --cache-control "$MUTABLE_CACHE_CONTROL" \
    --content-type "text/x-shellscript; charset=utf-8" \
    --metadata "sha256=$(sha256_file "$INSTALLER_PATH")" \
    --dryrun
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
    --preflight-only)
      PREFLIGHT_ONLY=1
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
if [[ "$DRY_RUN" -eq 0 && "$PREFLIGHT_ONLY" -eq 0 ]] && ! command -v curl >/dev/null 2>&1; then
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
validate_local_release_urls
export_aws_credentials_from_portable_env

EXPECTED_OBJECTS_PATH="$(mktemp "${TMPDIR:-/tmp}/first-tree-s3-expected-objects.XXXXXX")"
MISSING_OBJECTS_PATH="$(mktemp "${TMPDIR:-/tmp}/first-tree-s3-missing-objects.XXXXXX")"
trap 'rm -f "$EXPECTED_OBJECTS_PATH" "$MISSING_OBJECTS_PATH"' EXIT
write_expected_objects "$EXPECTED_OBJECTS_PATH"

if [[ "$DRY_RUN" -eq 1 ]]; then
  dry_run_uploads "$EXPECTED_OBJECTS_PATH"
  log "dry run completed; skipping S3 preflight and public URL verification"
  exit 0
fi

log "checking immutable version prefix compatibility: $(s3_uri "$CHANNEL/$VERSION")/"
check_remote_immutable_prefix "allow-missing" "$EXPECTED_OBJECTS_PATH" "$MISSING_OBJECTS_PATH"

if [[ "$PREFLIGHT_ONLY" -eq 1 ]]; then
  if [[ -s "$MISSING_OBJECTS_PATH" ]]; then
    log "preflight found missing immutable objects that can be uploaded by the final release step"
  fi
  log "preflight completed without immutable prefix conflicts"
  exit 0
fi

if [[ -s "$MISSING_OBJECTS_PATH" ]]; then
  while IFS=$'\t' read -r file_name local_path expected_sha expected_size content_type key; do
    [[ -n "$file_name" ]] || continue
    upload_immutable_object "$file_name" "$local_path" "$expected_sha" "$content_type" "$key"
  done < "$MISSING_OBJECTS_PATH"
else
  log "all immutable version objects already exist and match local artifacts"
fi

log "rechecking immutable version prefix before mutable channel updates"
check_remote_immutable_prefix "require-complete" "$EXPECTED_OBJECTS_PATH" "$MISSING_OBJECTS_PATH"

log "verifying the public versioned release before updating mutable channel entry points"
verify_remote_versioned_release

upload_mutable_object "latest.json" "$LATEST_PATH" "application/json" "$CHANNEL/latest.json"
upload_mutable_object "install.sh" "$INSTALLER_PATH" "text/x-shellscript; charset=utf-8" "$CHANNEL/install.sh"

verify_remote_channel_pointers
