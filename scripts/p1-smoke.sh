#!/usr/bin/env bash
# P1 end-to-end smoke for the @first-tree/auto bootstrap.
#
# Verifies (against the live worktree, no mocks):
#   1. capability check for tools the smoke needs
#   2. typecheck via tsc -b (project references)
#   3. apps/cli build via tsdown (shebang, bundle size, asset list)
#   4. workspace tests (apps/cli + packages/auto)
#   5. CLI surface: bare auto / args passthrough / --help / -h / help
#   6. exit code = 1 (P1 placeholder contract)
#   7. bin works through a symlink (npm-install simulation)
#   8. dist/index.js is self-contained (no runtime require of @first-tree/auto
#      and node_modules/.pnpm not on the PATH at run time)
#   9. no breeze residue in new code paths
#
# Run from the worktree root:
#   bash scripts/p1-smoke.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

. "$ROOT/scripts/lib.sh"

# 1. capability check ---------------------------------------------------------
step "1. capability check"
required=(node pnpm git grep awk file head)
missing=()
for tool in "${required[@]}"; do
  if ! command -v "$tool" >/dev/null; then
    missing+=("$tool")
  fi
done
if (( ${#missing[@]} )); then
  fail "missing tools: ${missing[*]}"
fi
node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if (( node_major < 22 )); then
  fail "node >= 22 required (found $node_major)"
fi
note "  node $(node --version) | pnpm $(pnpm --version)"

# 2. typecheck ---------------------------------------------------------------
step "2. typecheck (tsc -b)"
# Wipe any stale incremental cache so this step is the authoritative check.
# tsc -b skips emit if *.tsbuildinfo still claims the project is up to date.
rm -rf apps/cli/dist packages/auto/dist
find apps packages -maxdepth 3 -name "*.tsbuildinfo" -delete 2>/dev/null || true
pnpm -s typecheck >/dev/null
[[ -f apps/cli/dist/index.d.ts ]] || fail "missing apps/cli/dist/index.d.ts after tsc -b"
[[ -f packages/auto/dist/index.d.ts ]] || fail "missing packages/auto/dist/index.d.ts after tsc -b"
note "  tsc -b emitted .d.ts for both projects"

# 3. build -------------------------------------------------------------------
step "3. build (tsdown apps/cli)"
pnpm -s -C apps/cli run build >/dev/null
[[ -f apps/cli/dist/index.js ]] || fail "missing apps/cli/dist/index.js after tsdown"

shebang="$(head -1 apps/cli/dist/index.js)"
assert_eq "shebang" "#!/usr/bin/env node" "$shebang"

if [[ "$(file -b --mime-type apps/cli/dist/index.js)" != *"javascript"* ]]; then
  note "  (file mime: $(file -b --mime-type apps/cli/dist/index.js))"
fi

bytes="$(wc -c < apps/cli/dist/index.js | tr -d ' ')"
note "  dist/index.js size: ${bytes} bytes"
if (( bytes < 2000 )); then
  fail "dist/index.js too small (${bytes} bytes); bundle likely truncated"
fi
if (( bytes > 200000 )); then
  fail "dist/index.js unexpectedly large (${bytes} bytes); ext deps may have been bundled"
fi

# 4. workspace tests ---------------------------------------------------------
step "4. workspace tests (vitest)"
test_log="$(mktemp -t p1-smoke-tests.XXXXXX)"
trap 'rm -f "$test_log"' EXIT

run_pkg_tests() {
  local label="$1" filter="$2"
  : >"$test_log"
  if ! pnpm -C "$filter" test >"$test_log" 2>&1; then
    cat "$test_log"
    fail "$label tests failed"
  fi
  local summary
  summary="$(grep -E "Tests +[0-9]+ passed" "$test_log" | tail -1 || true)"
  [[ -n "$summary" ]] || {
    cat "$test_log"
    fail "no test summary captured for $label"
  }
  note "  $label: $summary"
}

run_pkg_tests "packages/auto" packages/auto
run_pkg_tests "apps/cli" apps/cli

# 5+6. CLI surface + exit code (P4 contract — runAuto returns AUTO_USAGE on
# bare/help, exits 1 on unknown subcommand)
step "5+6. CLI surface (auto, --help, -h, help, unknown) + exit code"

cli="$ROOT/apps/cli/dist/index.js"

# Bare / --help / -h / help all print AUTO_USAGE and exit 0.
usage_invocations=(
  "auto"
  "auto --help"
  "auto -h"
  "auto help"
)
for invocation in "${usage_invocations[@]}"; do
  set +e
  # shellcheck disable=SC2086
  stdout="$(node "$cli" $invocation 2>/dev/null)"
  exit_code=$?
  set -e
  assert_eq "exit code: first-tree $invocation" "0" "$exit_code"
  assert_contains "stdout: first-tree $invocation" "usage: first-tree auto" "$stdout"
done

# Unknown subcommand exits 1 with the prefixed error.
set +e
stdout="$(node "$cli" auto frobnicate 2>/dev/null)"
exit_code=$?
set -e
assert_eq "exit code: first-tree auto frobnicate" "1" "$exit_code"
assert_contains "stdout: first-tree auto frobnicate" "Unknown auto command:" "$stdout"

# Also verify the help index contains all four commands.
help_text="$(node "$cli" --help)"
for needle in "first-tree init" "first-tree tree inspect" "first-tree hub start" "first-tree auto"; do
  assert_contains "root --help" "$needle" "$help_text"
done

# 7. bin via symlink (npm install simulation) --------------------------------
step "7. bin via symlink"
tmpbin="$(mktemp -d -t p1-smoke-bin.XXXXXX)"
trap 'rm -f "$test_log"; rm -rf "$tmpbin"' EXIT
ln -s "$ROOT/apps/cli/dist/index.js" "$tmpbin/first-tree"
ln -s "$ROOT/apps/cli/dist/index.js" "$tmpbin/ft"
chmod +x "$ROOT/apps/cli/dist/index.js"
output_first="$("$tmpbin/first-tree" auto 2>/dev/null || true)"
output_ft="$("$tmpbin/ft" auto 2>/dev/null || true)"
assert_contains "symlink first-tree auto" "usage: first-tree auto" "$output_first"
assert_contains "symlink ft auto" "usage: first-tree auto" "$output_ft"

# 8. bundle self-containment -------------------------------------------------
step "8. bundle self-containment"
# 8a. dist/index.js must NOT carry a literal "@first-tree/auto" specifier:
#     tsdown's noExternal config inlines that workspace package, so the
#     compiled bundle never imports it at runtime.
if grep -F "@first-tree/auto" apps/cli/dist/index.js >/dev/null; then
  grep -nF "@first-tree/auto" apps/cli/dist/index.js | head -3 >&2
  fail "@first-tree/auto reference leaked into dist/index.js (noExternal failed)"
fi
note "  ok: @first-tree/auto fully inlined into dist/index.js"

# 8b. Inspect the surviving bare-import specifiers. They should be limited
#     to declared prod dependencies (commander) plus node: builtins. Any
#     unexpected workspace specifier would indicate a broken bundle.
imports="$(grep -oE 'from *"[^"]+"' apps/cli/dist/index.js | sed -E 's/from *"([^"]+)"/\1/' | sort -u)"
note "  imports in dist/index.js:"
printf '%s\n' "$imports" | sed 's/^/    /'
while IFS= read -r spec; do
  case "$spec" in
    "" | "commander" | node:* | ./* | ../* )
      ;;
    * )
      fail "unexpected import specifier in dist/index.js: $spec"
      ;;
  esac
done <<< "$imports"
note "  ok: only commander + node: + relative chunk imports remain"

# 9. namespace hygiene -------------------------------------------------------
step "9. namespace hygiene (A-class identifiers absent / B-class wire format kept)"
# A-class = namespace identifiers that must be renamed (BREEZE_* env names,
#   BreezeStatus / BreezePaths / classifyBreezeStatus / etc., ~/.breeze paths).
# B-class = wire format kept for Rust round-trip (breeze_status field,
#   "breeze:done" GitHub labels, Rust-runner historical references).

a_residue="$(grep -rnE "BREEZE_(DIR_ENV|HOME|HOST|POLL|INBOX|TASK|LOG|HTTP|MAX|SEARCH|BROKER|SNAPSHOT)" \
  packages/auto/src apps/cli/src/commands/auto 2>/dev/null || true)"
if [[ -n "$a_residue" ]]; then
  printf '  unexpected BREEZE_* env references:\n%s\n' "$a_residue" >&2
  fail "A-class env residue"
fi

a_idents="$(grep -rnE \
  "(BreezeStatus|BreezePaths|BreezePathsDeps|BreezeConfig|resolveBreezePaths|classifyBreezeStatus|loadBreezeConfig|loadBreezeDaemonConfig|breezeDaemonConfigSearchPaths|BREEZE_LABEL_META|ALL_BREEZE_LABELS|BreezeLabel)" \
  packages/auto/src apps/cli/src/commands/auto 2>/dev/null || true)"
if [[ -n "$a_idents" ]]; then
  printf '  unexpected BreezeXxx identifiers:\n%s\n' "$a_idents" >&2
  fail "A-class identifier residue"
fi

a_paths="$(grep -rnE "~/\.breeze[/[:space:]\"]" packages/auto/src apps/cli/src/commands/auto 2>/dev/null || true)"
if [[ -n "$a_paths" ]]; then
  printf '  unexpected ~/.breeze path references:\n%s\n' "$a_paths" >&2
  fail "A-class path residue"
fi

# A-class 4 (P3 D3): launchd label `com.breeze.runner.*` must not appear.
a_launchd="$(grep -rnE "com\.breeze\.runner" packages/auto/src 2>/dev/null || true)"
if [[ -n "$a_launchd" ]]; then
  printf '  unexpected com.breeze.runner label:\n%s\n' "$a_launchd" >&2
  fail "A-class launchd label residue"
fi

note "  ok: A-class identifiers / env / paths / launchd label are absent in src"

# B-class wire format must be present once runtime is ported. The grep for
# breeze_status / breeze:done is a positive assertion: if these vanish, the
# Rust-compatible wire format has drifted. We tolerate "no runtime yet"
# (P1 phase) by checking only when types.ts exists.
if [[ -f packages/auto/src/runtime/types.ts ]]; then
  for needle in "breeze_status" "\"breeze:done\""; do
    if ! grep -q "$needle" packages/auto/src/runtime/types.ts packages/auto/src/runtime/store.ts packages/auto/src/runtime/classifier.ts 2>/dev/null; then
      fail "B-class wire format missing: $needle"
    fi
  done
  note "  ok: B-class wire format ('breeze_status' / 'breeze:*' labels) preserved"
else
  note "  (runtime not ported yet; B-class assertions skipped)"
fi

# B-class wire format / D3 sanity check: launchd label must be the renamed
# `com.first-tree.auto.*` form (P3 D3).
if [[ -f packages/auto/src/daemon/launchd.ts ]]; then
  if ! grep -q "com.first-tree.auto" packages/auto/src/daemon/launchd.ts; then
    fail "P3 D3 launchd label missing: com.first-tree.auto.* not found in daemon/launchd.ts"
  fi
  note "  ok: P3 D3 launchd label ('com.first-tree.auto.*') in place"
fi

# Done -----------------------------------------------------------------------
printf '\n%sP1 smoke OK%s\n' "$ANSI_GREEN" "$ANSI_RESET"
