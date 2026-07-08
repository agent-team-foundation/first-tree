#!/bin/sh
set -eu

PORTABLE_CHANNEL="${FIRST_TREE_PORTABLE_CHANNEL:-prod}"
DOWNLOAD_BASE_URL="${FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL:-https://download.first-tree.ai/releases}"
DEFAULT_PREFIX="${HOME}/.local/share/first-tree/${PORTABLE_CHANNEL}"
DEFAULT_BIN_DIR="${HOME}/.local/bin"
PATH_MODE="auto"
REQUESTED_VERSION=""
PREFIX="$DEFAULT_PREFIX"
BIN_DIR="$DEFAULT_BIN_DIR"
PATH_UPDATED_PROFILE=""
ORIGINAL_PATH="${PATH:-}"

START_MARKER="# >>> first-tree portable >>>"
END_MARKER="# <<< first-tree portable <<<"

usage() {
  cat <<EOF
Usage: sh install.sh [options]

Options:
  --version <version>       Install an immutable version instead of latest
  --prefix <path>           Install root (default: $DEFAULT_PREFIX)
  --bin-dir <path>          Shim directory (default: $DEFAULT_BIN_DIR)
  --no-path-edit            Do not edit shell startup files
  --path-mode <mode>        auto, prompt, or off (default: auto)
  --help                    Show this help
EOF
}

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'first-tree portable installer: %s\n' "$*" >&2
  exit 1
}

need_value() {
  [ "$#" -ge 2 ] || die "$1 requires a value"
  case "$2" in
    --*) die "$1 requires a value" ;;
  esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      need_value "$1" "${2:-}"
      REQUESTED_VERSION="$2"
      shift 2
      ;;
    --prefix)
      need_value "$1" "${2:-}"
      PREFIX="$2"
      shift 2
      ;;
    --bin-dir)
      need_value "$1" "${2:-}"
      BIN_DIR="$2"
      shift 2
      ;;
    --no-path-edit)
      PATH_MODE="off"
      shift
      ;;
    --path-mode)
      need_value "$1" "${2:-}"
      case "$2" in
        auto|prompt|off) PATH_MODE="$2" ;;
        *) die "--path-mode must be auto, prompt, or off" ;;
      esac
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

trim_slashes() {
  printf '%s' "$1" | sed 's:/*$::'
}

download_to() {
  url="$1"
  dest="$2"
  if command_exists curl; then
    curl -fsSL "$url" -o "$dest"
  elif command_exists wget; then
    wget -qO "$dest" "$url"
  else
    die "curl or wget is required"
  fi
}

sha256_file() {
  file="$1"
  if command_exists sha256sum; then
    sha256sum "$file" | awk '{print $1}'
  elif command_exists shasum; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    die "sha256sum or shasum is required"
  fi
}

extract_tarball() {
  tarball="$1"
  dest="$2"
  if tar --version 2>/dev/null | grep -qi "GNU tar"; then
    tar --warning=no-unknown-keyword -xzf "$tarball" -C "$dest"
  else
    tar -xzf "$tarball" -C "$dest"
  fi
}

json_string() {
  file="$1"
  key="$2"
  sed -n "s/.*\"$key\": \"\\([^\"]*\\)\".*/\\1/p" "$file" | sed -n '1p'
}

json_number() {
  file="$1"
  key="$2"
  sed -n "s/.*\"$key\": \\([0-9][0-9]*\\).*/\\1/p" "$file" | sed -n '1p'
}

asset_block() {
  file="$1"
  platform="$2"
  awk -v needle="\"platform\": \"${platform}\"" '
    $0 ~ needle { found = 1 }
    found { print }
    found && $0 ~ /}/ { exit }
  ' "$file"
}

detect_platform() {
  os="$(uname -s 2>/dev/null || true)"
  machine="$(uname -m 2>/dev/null || true)"
  case "$os" in
    Darwin) portable_os="darwin" ;;
    Linux) portable_os="linux" ;;
    *) die "unsupported platform: ${os:-unknown}. Download and extract a matching portable tarball manually." ;;
  esac
  case "$machine" in
    arm64|aarch64) portable_arch="arm64" ;;
    x86_64|amd64) portable_arch="x64" ;;
    *) die "unsupported architecture: ${machine:-unknown}. Download and extract a matching portable tarball manually." ;;
  esac
  printf '%s-%s' "$portable_os" "$portable_arch"
}

write_shim() {
  path="$1"
  current_root="$2"
  tmp="${path}.$$"
  cat >"$tmp" <<EOF
#!/bin/sh
set -eu
root="$current_root"
export FIRST_TREE_INSTALL_MODE=portable
export FIRST_TREE_PORTABLE_ROOT="\$root"
exec "\$root/node/bin/node" "\$root/app/cli/index.mjs" "\$@"
EOF
  chmod 755 "$tmp"
  mv -f "$tmp" "$path"
}

atomic_replace_current_link() {
  new_link="$1"
  current_link="$2"
  os="$(uname -s 2>/dev/null || true)"
  case "$os" in
    Linux)
      if mv -f -T "$new_link" "$current_link"; then
        return 0
      fi
      ;;
    Darwin)
      if mv -f -h "$new_link" "$current_link"; then
        return 0
      fi
      ;;
    *)
      rm -f "$new_link"
      die "unsupported platform for atomic current replacement: ${os:-unknown}"
      ;;
  esac

  rm -f "$new_link"
  die "failed to atomically replace $current_link"
}

path_contains_bin_dir() {
  path_value="$1"
  case ":${path_value}:" in
    *:"$BIN_DIR":*) return 0 ;;
    *) return 1 ;;
  esac
}

portable_shim_wins_on_original_path() {
  bin_name="$1"
  old_path="${PATH:-}"
  PATH="$ORIGINAL_PATH"
  resolved="$(command -v "$bin_name" 2>/dev/null || true)"
  PATH="$old_path"
  [ "$resolved" = "$BIN_DIR/$bin_name" ]
}

profile_for_shell() {
  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    zsh) printf '%s/.zshrc' "$HOME" ;;
    bash)
      if [ -f "$HOME/.bashrc" ]; then
        printf '%s/.bashrc' "$HOME"
      else
        printf '%s/.bash_profile' "$HOME"
      fi
      ;;
    sh|dash|ksh) printf '%s/.profile' "$HOME" ;;
    *) return 1 ;;
  esac
}

rewrite_path_block() {
  profile="$1"
  tmp="${profile}.$$"
  if [ -f "$profile" ]; then
    awk -v start="$START_MARKER" -v end="$END_MARKER" '
      $0 == start { skip = 1; next }
      $0 == end { skip = 0; next }
      skip != 1 { print }
    ' "$profile" >"$tmp"
  else
    : >"$tmp"
  fi
  {
    cat "$tmp"
    printf '\n%s\n' "$START_MARKER"
    printf 'export PATH="%s:$PATH"\n' "$BIN_DIR"
    printf '%s\n' "$END_MARKER"
  } >"${tmp}.new"
  mv -f "${tmp}.new" "$profile"
  rm -f "$tmp"
}

maybe_edit_path() {
  bin_name="$1"
  [ "$PATH_MODE" != "off" ] || return 0
  if path_contains_bin_dir "$ORIGINAL_PATH" && portable_shim_wins_on_original_path "$bin_name"; then
    return 0
  fi

  if ! profile="$(profile_for_shell)"; then
    log "Automatic PATH setup skipped: this shell is not recognized."
    return 0
  fi

  if [ "$PATH_MODE" = "prompt" ]; then
    if [ ! -t 0 ]; then
      log "Automatic PATH setup skipped because prompt mode requires an interactive shell."
      return 0
    fi
    printf 'Add %s to PATH in %s? [Y/n] ' "$BIN_DIR" "$profile"
    read answer || answer="n"
    case "$answer" in
      ""|y|Y|yes|YES) ;;
      *)
        log "Skipped PATH setup."
        return 0
        ;;
    esac
  fi

  if rewrite_path_block "$profile"; then
    PATH_UPDATED_PROFILE="$profile"
    log "Updated PATH block in $profile"
  else
    log "PATH setup failed for $profile."
  fi
}

print_path_guidance() {
  if [ -n "$PATH_UPDATED_PROFILE" ]; then
    log "Restart your shell, or run: . \"$PATH_UPDATED_PROFILE\""
  elif path_contains_bin_dir "$ORIGINAL_PATH"; then
    # Judge against the user's incoming PATH: the installer prepends BIN_DIR
    # to its own PATH for recovery, which says nothing about the user's shell.
    log "$BIN_NAME should be available now."
  else
    log "Add this to your shell profile: export PATH=\"$BIN_DIR:\$PATH\""
  fi
}

clean_npm_temp_residue() {
  package_name="$1"
  case "$package_name" in
    first-tree|first-tree-staging) ;;
    *) return 0 ;;
  esac
  command_exists npm || return 0

  npm_root="$(npm root -g 2>/dev/null | sed -n '1p' || true)"
  [ -n "$npm_root" ] || return 0
  [ -d "$npm_root" ] || return 0

  for residue in "$npm_root/.$package_name"-*; do
    [ -e "$residue" ] || continue
    [ -d "$residue" ] || continue
    rm -rf "$residue"
    log "Removed stale npm temp directory: $residue"
  done
}

ensure_daemon_service() {
  bin_name="$1"
  if "$BIN_DIR/$bin_name" daemon ensure-service; then
    return 0
  fi
  log "Background service repair failed or is not available yet."
  log "Run $BIN_DIR/$bin_name login <token> to refresh credentials and service state."
}

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/first-tree-portable.XXXXXX")"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT HUP INT TERM

PLATFORM="$(detect_platform)"
BASE="$(trim_slashes "$DOWNLOAD_BASE_URL")"
if [ -n "$REQUESTED_VERSION" ]; then
  MANIFEST_URL="${BASE}/${PORTABLE_CHANNEL}/${REQUESTED_VERSION}/manifest.json"
else
  MANIFEST_URL="${BASE}/${PORTABLE_CHANNEL}/latest.json"
fi

MANIFEST_FILE="$WORK_DIR/manifest.json"
log "Downloading First Tree portable metadata: $MANIFEST_URL"
download_to "$MANIFEST_URL" "$MANIFEST_FILE"

VERSION="$(json_string "$MANIFEST_FILE" version)"
PACKAGE_NAME="$(json_string "$MANIFEST_FILE" packageName)"
BIN_NAME="$(json_string "$MANIFEST_FILE" binName)"
ALIAS_NAME="$(json_string "$MANIFEST_FILE" aliasName)"
[ -n "$VERSION" ] || die "metadata missing version"
[ -n "$PACKAGE_NAME" ] || die "metadata missing packageName"
[ -n "$BIN_NAME" ] || die "metadata missing binName"
[ -n "$ALIAS_NAME" ] || die "metadata missing aliasName"

ASSET_FILE="$WORK_DIR/asset.json"
asset_block "$MANIFEST_FILE" "$PLATFORM" >"$ASSET_FILE"
ASSET_PLATFORM="$(json_string "$ASSET_FILE" platform)"
ASSET_URL="$(json_string "$ASSET_FILE" url)"
ASSET_SHA="$(json_string "$ASSET_FILE" sha256)"
ASSET_SIZE="$(json_number "$ASSET_FILE" size)"
[ "$ASSET_PLATFORM" = "$PLATFORM" ] || die "no portable asset for $PLATFORM"
[ -n "$ASSET_URL" ] || die "asset missing url"
[ -n "$ASSET_SHA" ] || die "asset missing sha256"
[ -n "$ASSET_SIZE" ] || die "asset missing size"

clean_npm_temp_residue "$PACKAGE_NAME"
mkdir -p "$PREFIX/versions" "$PREFIX/.tmp" "$BIN_DIR"
TARBALL="$WORK_DIR/payload.tar.gz"
log "Downloading First Tree ${VERSION} for ${PLATFORM}"
download_to "$ASSET_URL" "$TARBALL"
ACTUAL_SHA="$(sha256_file "$TARBALL")"
if [ "$ACTUAL_SHA" != "$ASSET_SHA" ]; then
  die "checksum mismatch for portable payload: expected $ASSET_SHA, got $ACTUAL_SHA"
fi

FINAL_VERSION_DIR="$PREFIX/versions/$VERSION"
TEMP_VERSION_DIR="$PREFIX/.tmp/${VERSION}.$$"
rm -rf "$TEMP_VERSION_DIR"
mkdir -p "$TEMP_VERSION_DIR"
extract_tarball "$TARBALL" "$TEMP_VERSION_DIR"

if [ -e "$FINAL_VERSION_DIR" ]; then
  rm -rf "$TEMP_VERSION_DIR"
else
  mv "$TEMP_VERSION_DIR" "$FINAL_VERSION_DIR"
fi

CURRENT_LINK="$PREFIX/current"
if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
  die "$CURRENT_LINK exists and is not a symlink"
fi
NEW_LINK="$PREFIX/.current.$$"
rm -f "$NEW_LINK"
ln -s "$FINAL_VERSION_DIR" "$NEW_LINK"
atomic_replace_current_link "$NEW_LINK" "$CURRENT_LINK"

write_shim "$BIN_DIR/$BIN_NAME" "$CURRENT_LINK"
write_shim "$BIN_DIR/$ALIAS_NAME" "$CURRENT_LINK"

PATH="$BIN_DIR:${PATH:-}"
export PATH
"$BIN_DIR/$BIN_NAME" --version >/dev/null
maybe_edit_path "$BIN_NAME"
ensure_daemon_service "$BIN_NAME"

log "First Tree ${VERSION} installed at $FINAL_VERSION_DIR"
log "Command: $BIN_DIR/$BIN_NAME"
print_path_guidance
