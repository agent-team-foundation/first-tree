# Shared helpers for smoke/regression scripts.
# Source via: . "$(dirname "$0")/lib.sh" (or relative path equivalent).

ANSI_GREEN=$'\033[32m'
ANSI_YELLOW=$'\033[33m'
ANSI_RED=$'\033[31m'
ANSI_DIM=$'\033[2m'
ANSI_RESET=$'\033[0m'

step() {
  printf '\n%s== %s ==%s\n' "$ANSI_GREEN" "$1" "$ANSI_RESET"
}

warn() {
  printf '%s%s%s\n' "$ANSI_YELLOW" "$1" "$ANSI_RESET" >&2
}

fail() {
  printf '%sFAIL%s %s\n' "$ANSI_RED" "$ANSI_RESET" "$1" >&2
  exit 1
}

note() {
  printf '%s%s%s\n' "$ANSI_DIM" "$1" "$ANSI_RESET"
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    printf '  %s: expected %q, got %q\n' "$label" "$expected" "$actual" >&2
    fail "$label"
  fi
  note "  ok: $label = $actual"
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    printf '  %s: %q not found\n  haystack:\n%s\n' "$label" "$needle" "$haystack" >&2
    fail "$label"
  fi
  note "  ok: $label contains $needle"
}

assert_grep() {
  local label="$1" pattern="$2" file="$3"
  if ! grep -qE "$pattern" "$file"; then
    printf '  %s: pattern %q not found in %s\n' "$label" "$pattern" "$file" >&2
    fail "$label"
  fi
  note "  ok: $label"
}

assert_no_grep() {
  local label="$1" pattern="$2" file="$3"
  if grep -qE "$pattern" "$file" 2>/dev/null; then
    printf '  %s: forbidden pattern %q found in %s\n' "$label" "$pattern" "$file" >&2
    grep -nE "$pattern" "$file" | head -3 >&2
    fail "$label"
  fi
  note "  ok: $label"
}

assert_file() {
  local path="$1"
  [[ -f "$path" ]] || fail "expected file missing: $path"
  note "  ok: $path exists ($(wc -c < "$path" | tr -d ' ') bytes)"
}
