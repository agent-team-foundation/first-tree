#!/usr/bin/env bash
# P2 end-to-end smoke for the @first-tree/auto runtime port.
#
# This is a *delta* check on top of p1-smoke.sh — assumes P1 smoke is green.
# It verifies signals that vitest sandbox + P1 smoke do not cover:
#
#   1. tsc -b emits .d.ts for all 13 runtime modules + 1 daemon stub
#   2. compiled .d.ts surface: A-class renamed exports are present;
#      A-class old names (BreezeStatus, resolveBreezePaths, ...) absent
#   3. runtime import-graph closure: no module references main's
#      `src/products/breeze/*` path; only declared internal cross-imports
#   4. Rust wire format: fixture key order matches `fetcher.rs:601-631`
#      and store.ts:91 emits `breeze_status` (not `auto_status`)
#   5. paths.ts integration: a real Node.js process can resolve
#      AUTO_DIR + ~/.first-tree/auto layout via the worktree's compiled
#      .d.ts shape (compile-time check), and vitest paths.test.ts
#      passes the runtime-shape check
#
# Run from the worktree root:
#   bash scripts/p2-smoke.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

. "$ROOT/scripts/lib.sh"

# 1. typecheck emits all 13 runtime .d.ts ------------------------------------
step "1. tsc -b emits all 13 runtime .d.ts"
rm -rf packages/auto/dist apps/cli/dist
find apps packages -maxdepth 3 -name "*.tsbuildinfo" -delete 2>/dev/null || true
pnpm -s typecheck >/dev/null

declare -a expected_dts=(
  packages/auto/dist/index.d.ts
  packages/auto/dist/daemon/dispatcher.d.ts
)
for m in activity-log allow-repo classifier config gh identity paths \
         repo-filter store task task-kind task-util types; do
  expected_dts+=("packages/auto/dist/runtime/${m}.d.ts")
done

for f in "${expected_dts[@]}"; do
  [[ -f "$f" ]] || fail "missing $f"
done
note "  ok: 15 .d.ts present (1 index + 1 daemon stub + 13 runtime)"

# 2. compiled .d.ts surface: A-class renames are exported --------------------
step "2. .d.ts API surface (A-class renamed exports present)"

assert_grep "AUTO_DIR_ENV exported" \
  'AUTO_DIR_ENV' packages/auto/dist/runtime/paths.d.ts
assert_grep "resolveAutoPaths exported" \
  'resolveAutoPaths' packages/auto/dist/runtime/paths.d.ts
assert_grep "AutoPaths interface exported" \
  'AutoPaths' packages/auto/dist/runtime/paths.d.ts
assert_grep "AutoStatusSchema exported" \
  'AutoStatusSchema' packages/auto/dist/runtime/types.d.ts
assert_grep "AutoStatus type exported" \
  'AutoStatus' packages/auto/dist/runtime/types.d.ts
assert_grep "AUTO_LABEL_META exported" \
  'AUTO_LABEL_META' packages/auto/dist/runtime/types.d.ts
assert_grep "ALL_AUTO_LABELS exported" \
  'ALL_AUTO_LABELS' packages/auto/dist/runtime/types.d.ts
assert_grep "classifyAutoStatus exported" \
  'classifyAutoStatus' packages/auto/dist/runtime/classifier.d.ts
assert_grep "AutoConfig exported" \
  'AutoConfig' packages/auto/dist/runtime/config.d.ts
assert_grep "loadAutoConfig exported" \
  'loadAutoConfig' packages/auto/dist/runtime/config.d.ts
assert_grep "loadAutoDaemonConfig exported" \
  'loadAutoDaemonConfig' packages/auto/dist/runtime/config.d.ts
assert_grep "autoDaemonConfigSearchPaths exported" \
  'autoDaemonConfigSearchPaths' packages/auto/dist/runtime/config.d.ts
assert_grep "TaskCandidate exported (P2 stub)" \
  'TaskCandidate' packages/auto/dist/daemon/dispatcher.d.ts

assert_no_grep "BREEZE_DIR_ENV gone" 'BREEZE_DIR_ENV' packages/auto/dist/runtime/paths.d.ts
assert_no_grep "resolveBreezePaths gone" 'resolveBreezePaths' packages/auto/dist/runtime/paths.d.ts
assert_no_grep "BreezePaths interface gone" '\bBreezePaths\b' packages/auto/dist/runtime/paths.d.ts
assert_no_grep "BreezeStatusSchema gone" 'BreezeStatusSchema' packages/auto/dist/runtime/types.d.ts
assert_no_grep "BreezeStatus type gone" '\bBreezeStatus\b' packages/auto/dist/runtime/types.d.ts
assert_no_grep "BREEZE_LABEL_META gone" 'BREEZE_LABEL_META' packages/auto/dist/runtime/types.d.ts
assert_no_grep "ALL_BREEZE_LABELS gone" 'ALL_BREEZE_LABELS' packages/auto/dist/runtime/types.d.ts
assert_no_grep "classifyBreezeStatus gone" 'classifyBreezeStatus' packages/auto/dist/runtime/classifier.d.ts
assert_no_grep "loadBreezeConfig gone" 'loadBreezeConfig' packages/auto/dist/runtime/config.d.ts

# 3. runtime import-graph closure --------------------------------------------
step "3. runtime import-graph closure (no main-path leakage)"
leaks="$(grep -rnE "from\s+['\"][^'\"]*products/breeze" packages/auto/src 2>/dev/null || true)"
if [[ -n "$leaks" ]]; then
  printf '  unexpected references to main "products/breeze/*":\n%s\n' "$leaks" >&2
  fail "main-path leakage"
fi
note "  ok: no module references src/products/breeze/*"

# task.ts must reach dispatcher TaskCandidate via local stub
assert_grep "task.ts -> daemon/dispatcher.js" \
  'from "\.\./daemon/dispatcher\.js"' packages/auto/src/runtime/task.ts

# 4. Rust wire format integrity ----------------------------------------------
step "4. Rust wire format integrity (breeze_status field + key order)"
# 4a. store.ts must emit "breeze_status" key (not "auto_status")
assert_grep "store.ts emits breeze_status" \
  'breeze_status:' packages/auto/src/runtime/store.ts
assert_no_grep "store.ts has no auto_status leak" \
  'auto_status:' packages/auto/src/runtime/store.ts

# 4b. fixture inbox-sample.json: first entry's keys match fetcher.rs:601-631 order
fixture="$ROOT/packages/auto/tests/fixtures/inbox-sample.json"
[[ -f "$fixture" ]] || fail "fixture missing: $fixture"

# Extract the key sequence of the first entry (regex-based — node JSON.parse
# would not preserve key order, but we want byte-level order, so regex is
# correct here).
key_sequence="$(grep -oE '"(id|type|reason|repo|title|url|last_actor|updated_at|unread|priority|number|html_url|gh_state|labels|breeze_status)"' "$fixture" \
  | head -15 | tr '\n' ',' | sed 's/,$//')"
expected='"id","type","reason","repo","title","url","last_actor","updated_at","unread","priority","number","html_url","gh_state","labels","breeze_status"'
if [[ "$key_sequence" != "$expected" ]]; then
  printf '  key sequence mismatch.\n  expected: %s\n  actual:   %s\n' "$expected" "$key_sequence" >&2
  fail "fixture key order"
fi
note "  ok: fixture inbox-sample.json keys match fetcher.rs:601-631 order"

# 4c. types.ts InboxEntrySchema must declare keys in the same order
# (head -15 trims to InboxEntry's 15 keys; the next schema starts after.)
schema_keys="$(grep -oE '^[[:space:]]+(id|type|reason|repo|title|url|last_actor|updated_at|unread|priority|number|html_url|gh_state|labels|breeze_status):' packages/auto/src/runtime/types.ts \
  | head -15 \
  | awk -F: '{ gsub(/[[:space:]]/, "", $1); print $1 }' \
  | tr '\n' ',' | sed 's/,$//')"
expected_schema='id,type,reason,repo,title,url,last_actor,updated_at,unread,priority,number,html_url,gh_state,labels,breeze_status'
if [[ "$schema_keys" != "$expected_schema" ]]; then
  printf '  schema keys mismatch.\n  expected: %s\n  actual:   %s\n' "$expected_schema" "$schema_keys" >&2
  fail "InboxEntrySchema key order"
fi
note "  ok: types.ts InboxEntrySchema keys match wire-format order"

# 5. runtime test signal: paths.test + store.test focused run ----------------
step "5. focused vitest run (paths + store, real fs)"
test_log="$(mktemp -t p2-smoke-tests.XXXXXX)"
trap 'rm -f "$test_log"' EXIT

if ! pnpm -C packages/auto exec vitest run \
    tests/runtime/paths.test.ts \
    tests/runtime/store.test.ts \
    >"$test_log" 2>&1; then
  cat "$test_log"
  fail "paths/store focused run"
fi
summary="$(grep -E "Tests +[0-9]+ passed" "$test_log" | tail -1 || true)"
[[ -n "$summary" ]] || {
  cat "$test_log"
  fail "no test summary captured"
}
note "  $summary"

# Done -----------------------------------------------------------------------
printf '\n%sP2 smoke OK%s\n' "$ANSI_GREEN" "$ANSI_RESET"
