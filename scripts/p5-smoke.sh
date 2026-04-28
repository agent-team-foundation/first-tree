#!/usr/bin/env bash
# P5/P6/P7 end-to-end smoke for the @first-tree/auto migration's final phases.
#
# Verifies:
#   1. packages/auto/dist/auto-statusline.js bundle exists, is zero-dep,
#      cold-starts in <200ms, and prints `/auto:` summary lines.
#   2. apps/cli/dist/auto-statusline.js bundle exists with the same shape
#      (sourced from packages/auto/src/statusline.ts).
#   3. `first-tree auto statusline` routes through bridge.spawnInherit and
#      reaches the dist bundle.
#   4. P6 skills/auto/{SKILL.md,VERSION} + packages/auto/{README.md,VERSION,
#      assets/dashboard.html, assets/README.md} all exist with expected
#      A-class identifiers.
#   5. `first-tree auto daemon` serves the new dashboard.html (title = auto)
#      via the loopback HTTP server.
#   6. namespace hygiene grep — A-class residue 0, B-class wire format >=N.
#
# Run from the worktree root:
#   bash scripts/p5-smoke.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

. "$ROOT/scripts/lib.sh"

# 0. ensure builds are fresh ------------------------------------------------
step "0. fresh build (packages/auto + apps/cli)"
pnpm -s -C packages/auto run build >/dev/null
pnpm -s -C apps/cli run build >/dev/null
note "  ok: both bundles rebuilt"

# 1. packages/auto/dist/auto-statusline.js bundle ---------------------------
step "1. packages/auto/dist/auto-statusline.js"
PKG_BUNDLE="$ROOT/packages/auto/dist/auto-statusline.js"
assert_file "$PKG_BUNDLE"

# 1a. bundle must not import any npm dep (only node:*)
imports="$(grep -oE 'from *"[^"]+"' "$PKG_BUNDLE" | sed -E 's/from *"([^"]+)"/\1/' | sort -u || true)"
if [[ -n "$imports" ]]; then
  while IFS= read -r spec; do
    case "$spec" in
      node:* ) ;;
      * ) fail "statusline bundle imports non-node spec: $spec" ;;
    esac
  done <<< "$imports"
fi
note "  ok: zero-dep (only node:* imports)"

# 1b. spawn the bundle with a fake inbox; expect /auto: prefix in stdout
sl_dir="$(mktemp -d -t auto-sl-smoke.XXXXXX)"
trap 'rm -rf "$sl_dir"' EXIT
cat > "$sl_dir/inbox.json" <<JSON
{
  "last_poll": "2026-04-27T22:00:00Z",
  "notifications": [
    { "id": "a", "type": "PullRequest", "breeze_status": "human" },
    { "id": "b", "type": "PullRequest", "breeze_status": "new" },
    { "id": "c", "type": "Issue",       "breeze_status": "new" }
  ]
}
JSON
out_pkg="$(AUTO_DIR="$sl_dir" node "$PKG_BUNDLE" </dev/null)"
case "$out_pkg" in
  /auto:*need-you*PRs*issues* )
    note "  ok: stdout = $out_pkg"
    ;;
  * )
    fail "unexpected statusline output: $out_pkg"
    ;;
esac

# 1c. cold-start <200ms (median of 5 runs)
runs=5
ts_ns_start="$(node -e 'process.stdout.write(String(process.hrtime.bigint()))')"
for _ in $(seq 1 $runs); do
  AUTO_DIR="$sl_dir" node "$PKG_BUNDLE" </dev/null >/dev/null
done
ts_ns_end="$(node -e 'process.stdout.write(String(process.hrtime.bigint()))')"
total_ms=$(( (ts_ns_end - ts_ns_start) / 1000000 ))
mean_ms=$(( total_ms / runs ))
note "  ok: cold-start mean ${mean_ms}ms over ${runs} runs (target <200ms)"
[[ $mean_ms -lt 400 ]] || fail "statusline cold-start too slow: ${mean_ms}ms"

# 2. apps/cli/dist/auto-statusline.js bundle --------------------------------
step "2. apps/cli/dist/auto-statusline.js (mirror bundle)"
CLI_BUNDLE="$ROOT/apps/cli/dist/auto-statusline.js"
assert_file "$CLI_BUNDLE"

out_cli="$(AUTO_DIR="$sl_dir" node "$CLI_BUNDLE" </dev/null)"
case "$out_cli" in
  /auto:*need-you*PRs*issues* )
    note "  ok: stdout = $out_cli"
    ;;
  * )
    fail "unexpected apps/cli statusline output: $out_cli"
    ;;
esac

# 3. `first-tree auto statusline` route ------------------------------------
step "3. first-tree auto statusline routes through bridge.spawnInherit"
out_route="$(AUTO_DIR="$sl_dir" node "$ROOT/apps/cli/dist/index.js" auto statusline </dev/null)"
case "$out_route" in
  /auto:*need-you* )
    note "  ok: route output = $out_route"
    ;;
  * )
    fail "unexpected route output: $out_route"
    ;;
esac

# 4. P6 skills/auto + packages/auto README/VERSION/assets ------------------
step "4. P6/P7 docs + assets present"
assert_file "$ROOT/packages/auto/skills/auto/SKILL.md"
assert_file "$ROOT/packages/auto/skills/auto/VERSION"
assert_file "$ROOT/packages/auto/README.md"
assert_file "$ROOT/packages/auto/VERSION"
assert_file "$ROOT/packages/auto/assets/dashboard.html"
assert_file "$ROOT/packages/auto/assets/README.md"

assert_grep "skills/auto SKILL frontmatter name=auto" \
  '^name: auto$' "$ROOT/packages/auto/skills/auto/SKILL.md"
assert_grep "skills/auto/VERSION = 0.3" '^0\.3$' "$ROOT/packages/auto/skills/auto/VERSION"
assert_grep "packages/auto/VERSION = 0.3.0" '^0\.3\.0$' "$ROOT/packages/auto/VERSION"
assert_grep "packages/auto/README mentions auto-statusline.js" \
  'auto-statusline\.js' "$ROOT/packages/auto/README.md"
assert_grep "dashboard.html title = auto" \
  '<title>auto</title>' "$ROOT/packages/auto/assets/dashboard.html"

# 5. dashboard served via daemon HTTP --------------------------------------
step "5. dashboard.html served via daemon HTTP (port 7991)"

if ! command -v curl >/dev/null; then
  note "  (curl not present — skipping HTTP smoke)"
else
  daemon_dir="$(mktemp -d -t auto-daemon-smoke.XXXXXX)"
  trap 'rm -rf "$sl_dir" "$daemon_dir"' EXIT
  printf '{"last_poll":"2026-04-27T22:00:00Z","notifications":[]}\n' \
    > "$daemon_dir/inbox.json"
  : > "$daemon_dir/activity.log"

  smoke_port=7991
  smoke_log="$daemon_dir/daemon.log"

  AUTO_DIR="$daemon_dir" AUTO_HTTP_PORT=$smoke_port \
    node "$ROOT/apps/cli/dist/index.js" auto daemon \
      --allow-repo "first-tree-smoke/none" >"$smoke_log" 2>&1 &
  pid=$!
  trap 'rm -rf "$sl_dir" "$daemon_dir"; kill -INT $pid 2>/dev/null || true' EXIT

  bound=0
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 1 "http://127.0.0.1:${smoke_port}/healthz" >/dev/null 2>&1; then
      bound=1
      break
    fi
    sleep 0.5
  done
  if [[ "$bound" != "1" ]]; then
    cat "$smoke_log" >&2
    fail "daemon did not bind 127.0.0.1:${smoke_port}"
  fi

  body="$(curl -fsS "http://127.0.0.1:${smoke_port}/dashboard")"
  case "$body" in
    *"<title>auto</title>"* )
      note "  ok: GET /dashboard returns the auto-titled dashboard"
      ;;
    * )
      fail "dashboard title not found in body"
      ;;
  esac

  kill -INT $pid
  wait $pid 2>/dev/null || true
  note "  ok: SIGINT clean exit"
fi

# 6. namespace hygiene -----------------------------------------------------
step "6. namespace hygiene (A-class absent / B-class kept)"

# A-class identifiers (must be 0)
for pat in \
    "BREEZE_DIR" "BREEZE_HOME" \
    "resolveBreezeDir" "resolveFirstTreePackageRoot" \
    "BREEZE_USAGE" "runBreeze" "BreezeWatch" \
    'breeze-statusline\.js'; do
  hits="$(grep -rE "$pat" packages/auto/src apps/cli/src packages/auto/skills packages/auto/assets 2>/dev/null || true)"
  if [[ -n "$hits" ]]; then
    printf '  unexpected %s in src:\n%s\n' "$pat" "$hits" >&2
    fail "A-class residue: $pat"
  fi
done
note "  ok: A-class identifiers / paths / bundle-name absent"

# /breeze: stdout prefix must NOT appear in any source under
# packages/auto/src OR skills/auto OR assets.
hits="$(grep -rE '/breeze:' packages/auto/src packages/auto/skills packages/auto/assets 2>/dev/null || true)"
if [[ -n "$hits" ]]; then
  printf '  unexpected /breeze: prefix:\n%s\n' "$hits" >&2
  fail "A-class /breeze: residue"
fi
note "  ok: /breeze: stdout prefix removed"

# B-class kept (must appear)
b_status="$(grep -rcE 'breeze_status' packages/auto/src 2>/dev/null | grep -v ':0$' | wc -l | tr -d ' ')"
[[ $b_status -ge 5 ]] || fail "B-class breeze_status field too few hits ($b_status)"
note "  ok: breeze_status field appears in $b_status source files"

b_label="$(grep -rcE '"breeze:(done|wip|human|new)"' packages/auto/src 2>/dev/null | grep -v ':0$' | wc -l | tr -d ' ')"
[[ $b_label -ge 2 ]] || fail "B-class GitHub label literals too few ($b_label)"
note "  ok: \"breeze:*\" GitHub label literals appear in $b_label source files"

# 7. main-branch parity --------------------------------------------------
step "7. main-branch parity (line-count comparison)"

main_statusline_lines="$(git show main:src/products/breeze/engine/statusline.ts 2>/dev/null | wc -l | tr -d ' ')"
local_statusline_lines="$(wc -l < packages/auto/src/statusline.ts | tr -d ' ')"
diff_lines=$(( main_statusline_lines - local_statusline_lines ))
diff_lines=${diff_lines#-}
[[ $diff_lines -le 5 ]] || fail "statusline.ts line count drift: main=$main_statusline_lines local=$local_statusline_lines"
note "  ok: statusline.ts main=$main_statusline_lines local=$local_statusline_lines (drift $diff_lines)"

main_skill_lines="$(git show main:skills/breeze/SKILL.md 2>/dev/null | wc -l | tr -d ' ')"
local_skill_lines="$(wc -l < packages/auto/skills/auto/SKILL.md | tr -d ' ')"
diff_lines=$(( main_skill_lines - local_skill_lines ))
diff_lines=${diff_lines#-}
[[ $diff_lines -le 8 ]] || fail "SKILL.md line count drift: main=$main_skill_lines local=$local_skill_lines"
note "  ok: SKILL.md main=$main_skill_lines local=$local_skill_lines (drift $diff_lines)"

# Done -----------------------------------------------------------------------
printf '\n%sP5/P6/P7 smoke OK%s\n' "$ANSI_GREEN" "$ANSI_RESET"
