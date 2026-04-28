#!/usr/bin/env bash
# P3 end-to-end smoke for the @first-tree/auto daemon port.
#
# Delta on top of P1 + P2 smokes — assumes both are green. Verifies signals
# that vitest sandbox + P1/P2 don't cover:
#
#   1. tsc -b emits .d.ts for all 17 daemon modules + 2 commands stubs
#   2. compiled .d.ts surface: daemon entrypoints + Dispatcher + http server
#      are exported (replacing P2 stub form)
#   3. daemon import-graph closure: no module references main's
#      `src/products/breeze/*` path
#   4. P3 D3/D4 wire format: launchd label is `com.first-tree.auto.*`,
#      runtime/config default httpPort is 7879
#   5. focused vitest run (launchd.test + http.test, real fs)
#   6. runAuto(["daemon"]) HTTP smoke (v4 §13.10 P3): spawn the daemon
#      via `node apps/cli/dist/index.js auto daemon`, hit /healthz and
#      /inbox over loopback, then SIGINT and verify clean exit.
#
# Run from the worktree root:
#   bash scripts/p3-smoke.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

. "$ROOT/scripts/lib.sh"

# 1. typecheck emits all 17 daemon .d.ts + 2 commands stubs ------------------
step "1. tsc -b emits 17 daemon .d.ts + 2 commands stubs + 1 cli stub"
rm -rf packages/auto/dist apps/cli/dist
find apps packages -maxdepth 3 -name "*.tsbuildinfo" -delete 2>/dev/null || true
pnpm -s typecheck >/dev/null

declare -a expected_dts=(
  packages/auto/dist/cli.d.ts
  packages/auto/dist/commands/poll.d.ts
  packages/auto/dist/commands/start.d.ts
)
for m in broker bus candidate-loop claim dispatcher gh-client gh-executor http \
         identity launchd poller runner runner-skeleton scheduler sse \
         thread-store workspace; do
  expected_dts+=("packages/auto/dist/daemon/${m}.d.ts")
done

for f in "${expected_dts[@]}"; do
  [[ -f "$f" ]] || fail "missing $f"
done
note "  ok: 17 daemon + 2 commands + 1 cli .d.ts present"

# 2. .d.ts surface ----------------------------------------------------------
step "2. daemon .d.ts API surface (P3 entrypoints exported)"
assert_grep "startHttpServer" 'startHttpServer' packages/auto/dist/daemon/http.d.ts
assert_grep "RunningHttpServer" 'RunningHttpServer' packages/auto/dist/daemon/http.d.ts
assert_grep "runDaemon"     'runDaemon'        packages/auto/dist/daemon/runner-skeleton.d.ts
assert_grep "parseDaemonArgs" 'parseDaemonArgs' packages/auto/dist/daemon/runner-skeleton.d.ts
assert_grep "Dispatcher class" 'Dispatcher'     packages/auto/dist/daemon/dispatcher.d.ts
assert_grep "TaskCandidate"    'TaskCandidate'  packages/auto/dist/daemon/dispatcher.d.ts
assert_grep "createBus"        'createBus'      packages/auto/dist/daemon/bus.d.ts
assert_grep "launchdLabel"     'launchdLabel'   packages/auto/dist/daemon/launchd.d.ts
assert_grep "WorkspaceManager" 'WorkspaceManager' packages/auto/dist/daemon/workspace.d.ts
assert_grep "ThreadStore"      'ThreadStore'    packages/auto/dist/daemon/thread-store.d.ts
assert_grep "extractBackendFlag (cli stub)" 'extractBackendFlag' packages/auto/dist/cli.d.ts
assert_grep "defaultDaemonArgs (start stub)" 'defaultDaemonArgs' packages/auto/dist/commands/start.d.ts
assert_grep "parseNotifications (poll helper)" 'parseNotifications' packages/auto/dist/commands/poll.d.ts

# 3. import-graph closure ---------------------------------------------------
step "3. daemon import-graph closure (no main-path leakage)"
leaks="$(grep -rnE "from\s+['\"][^'\"]*products/breeze" packages/auto/src 2>/dev/null || true)"
if [[ -n "$leaks" ]]; then
  printf '  unexpected references to main "products/breeze/*":\n%s\n' "$leaks" >&2
  fail "main-path leakage"
fi
note "  ok: no module references src/products/breeze/*"

# poller.ts must reach commands/poll helpers via local stub
assert_grep "poller.ts -> commands/poll.js" \
  'from "\.\./commands/poll\.js"' packages/auto/src/daemon/poller.ts
# launchd.test must reach commands/start helpers via local stub
assert_grep "launchd.test -> commands/start.js" \
  'from "\.\./\.\./src/commands/start\.js"' packages/auto/tests/daemon/launchd.test.ts

# 4. P3 D3/D4 wire format integrity -----------------------------------------
step "4. P3 D3 launchd label + D4 HTTP port default"
# 4a. launchd label = com.first-tree.auto.*
assert_grep "launchd label is com.first-tree.auto.*" \
  'com\.first-tree\.auto' packages/auto/src/daemon/launchd.ts
if grep -qE 'com\.breeze\.runner' packages/auto/src/daemon/launchd.ts; then
  fail "stale com.breeze.runner label still present"
fi
note "  ok: launchd label is com.first-tree.auto.<login>.<profile>"

# 4b. PASSTHROUGH_ENV_VARS uses AUTO_DIR / AUTO_HOME
assert_grep "PASSTHROUGH AUTO_DIR" '"AUTO_DIR"' packages/auto/src/daemon/launchd.ts
assert_grep "PASSTHROUGH AUTO_HOME" '"AUTO_HOME"' packages/auto/src/daemon/launchd.ts

# 4c. runtime/config default httpPort = 7879
assert_grep "httpPort default 7879" 'httpPort: 7879' packages/auto/src/runtime/config.ts
if grep -qE 'httpPort: 7878' packages/auto/src/runtime/config.ts; then
  fail "stale httpPort: 7878 default still present"
fi
note "  ok: runtime/config.ts default httpPort = 7879"

# 5. focused vitest run (launchd + http real fs) ----------------------------
step "5. focused vitest run (launchd + http, real fs)"
test_log="$(mktemp -t p3-smoke-tests.XXXXXX)"
trap 'rm -f "$test_log"' EXIT

if ! pnpm -C packages/auto exec vitest run \
    tests/daemon/launchd.test.ts \
    tests/daemon/http.test.ts \
    >"$test_log" 2>&1; then
  cat "$test_log"
  fail "launchd/http focused run"
fi
summary="$(grep -E "Tests +[0-9]+ passed" "$test_log" | tail -1 || true)"
[[ -n "$summary" ]] || {
  cat "$test_log"
  fail "no test summary captured"
}
note "  $summary"

# 6. runAuto(['daemon']) HTTP smoke -----------------------------------------
step "6. runAuto(['daemon']) HTTP smoke (v4 §13.10 P3)"

if ! command -v curl >/dev/null; then
  note "  (curl not present — skipping HTTP smoke)"
else
  pnpm -s -C apps/cli run build >/dev/null

  # Use AUTO_DIR isolation to avoid touching real ~/.first-tree
  smoke_dir="$(mktemp -d -t auto-p3-smoke.XXXXXX)"
  trap 'rm -rf "$smoke_dir"; rm -f "$test_log"' EXIT
  printf '{"last_poll":"2026-04-27T00:00:00Z","notifications":[]}\n' \
    > "$smoke_dir/inbox.json"
  : > "$smoke_dir/activity.log"

  smoke_port=7990
  smoke_log="$smoke_dir/daemon.log"

  # P4 cli.ts goes through runDaemon, which requires --allow-repo.
  # Use a non-existent repo so the poll cycle is a fast no-op.
  AUTO_DIR="$smoke_dir" AUTO_HTTP_PORT=$smoke_port \
    node "$ROOT/apps/cli/dist/index.js" auto daemon \
      --allow-repo "first-tree-smoke/none" >"$smoke_log" 2>&1 &
  pid=$!
  trap 'rm -rf "$smoke_dir"; rm -f "$test_log"; kill -INT $pid 2>/dev/null || true' EXIT

  # Wait up to 30s for the listener (P4: cli.ts → runDaemon does full bootstrap
  # — identity resolution + dispatcher + broker bring-up — before binding HTTP).
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
    fail "daemon did not bind 127.0.0.1:${smoke_port} within 30s"
  fi

  health="$(curl -fsS "http://127.0.0.1:${smoke_port}/healthz")"
  if [[ "$health" != "ok"* ]]; then
    fail "expected healthz body to start with 'ok', got: $(printf '%q' "$health")"
  fi
  note "  ok: GET /healthz responded 200"

  # P4: cli.ts → runDaemon runs a real poll cycle on startup, so the
  # initial empty fixture may have been overwritten with whatever the
  # local `gh` CLI sees. Just assert the response is JSON with the
  # notifications array shape.
  inbox="$(curl -fsS "http://127.0.0.1:${smoke_port}/inbox")"
  if [[ "$inbox" != *'"notifications":'* ]]; then
    fail "expected /inbox to return JSON with notifications key; got: $inbox"
  fi
  note "  ok: GET /inbox returns notifications array"

  # Graceful SIGINT shutdown
  kill -INT $pid
  if ! wait $pid 2>/dev/null; then
    note "  (daemon exited non-zero — expected for SIGINT abort)"
  fi
  note "  ok: SIGINT exit (no hang)"

  rm -rf "$smoke_dir"
  trap 'rm -f "$test_log"' EXIT
fi

# Done -----------------------------------------------------------------------
printf '\n%sP3 smoke OK%s\n' "$ANSI_GREEN" "$ANSI_RESET"
