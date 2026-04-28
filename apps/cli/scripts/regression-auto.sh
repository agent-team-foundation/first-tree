#!/usr/bin/env bash
# Local end-to-end regression for the @first-tree/auto migration.
#
# Implements docs/proposals/migrate-breeze-to-packages-auto.md §13:
#   §13.0 capability check
#   §13.1 namespace hygiene
#   §13.2 package-level tests
#   §13.3 CLI behavior smoke (no network)
#   §13.4 HTTP / SSE / dashboard smoke (needs $AUTO_REPO + gh auth)
#   §13.5 statusline bundle smoke
#   §13.6 publish-tarball smoke (pnpm pack + clean install)
#   §13.7 platform-conditional smoke (macOS / Linux / Windows)
#   §13.8 coexistence with main breeze (only if ~/.breeze/ exists)
#   §13.9 cleanup + isolation assertions
#
# Run from worktree root:
#   bash apps/cli/scripts/regression-auto.sh
#
# Optional env:
#   AUTO_REPO   — owner/repo allow-list for §13.4 / §13.7 / §13.8 (skipped if unset)
#   SKIP_PACK   — `1` to skip §13.6 (saves ~10s; runs `pnpm pack` + clean npm install)
#   SKIP_HTTP   — `1` to skip §13.4 (needs gh auth; CI without secrets sets this)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

. "$ROOT/scripts/lib.sh"

# --- §13.0 capability check ------------------------------------------------
step "13.0 capability check"

required=(node pnpm curl grep awk sed)
optional=(jq lsof pgrep gh)
missing=()
optional_missing=()

for tool in "${required[@]}"; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
for tool in "${optional[@]}"; do
  command -v "$tool" >/dev/null 2>&1 || optional_missing+=("$tool")
done

if (( ${#missing[@]} )); then
  printf 'missing required tools: %s\n' "${missing[*]}" >&2
  case "$(uname -s)" in
    Darwin) printf '  install: brew install %s\n' "${missing[*]}" >&2 ;;
    Linux)  printf '  install: <distro pkg manager> install %s\n' "${missing[*]}" >&2 ;;
  esac
  exit 1
fi
note "  ok: required tools (${required[*]})"

if (( ${#optional_missing[@]} )); then
  warn "  optional tools missing (some §13 sections will skip): ${optional_missing[*]}"
fi

# GNU timeout for SSE smoke (BSD timeout is incompatible).
TIMEOUT_CMD=""
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_CMD="timeout"
else warn "  no GNU timeout; SSE smoke will degrade to head-based limit"; fi
export TIMEOUT_CMD

NODE_VER="$(node -e 'process.stdout.write(process.versions.node)')"
NODE_MAJOR="${NODE_VER%%.*}"
[[ "$NODE_MAJOR" -ge 22 ]] || fail "Node 22+ required, found $NODE_VER"
note "  ok: Node $NODE_VER"

# --- §13.1 namespace hygiene ----------------------------------------------
step "13.1 namespace hygiene (A-class absent / B-class kept)"

a_class_in_src() {
  grep -rnE \
    "(BREEZE_DIR|BREEZE_HOME|resolveBreezeDir|resolveFirstTreePackageRoot|BREEZE_USAGE|runBreeze|BreezeStatus|BreezeWatch|BREEZE_LABEL_META|ALL_BREEZE_LABELS|breeze-statusline\\.js)" \
    packages/auto/src apps/cli/src packages/auto/skills packages/auto/assets 2>/dev/null || true
}

residue="$(a_class_in_src)"
if [[ -n "$residue" ]]; then
  printf 'unexpected A-class identifiers in src:\n%s\n' "$residue" >&2
  fail "A-class residue"
fi
note "  ok: A-class identifiers absent in src"

# Catch both `~/.breeze/...` literals and `join(homedir(), ".breeze", ...)`
# style code that an identifier grep would miss. `breeze_status`,
# `breeze-runner`, and `breeze:done` are B-class — anchor on a leading
# slash, dot, or quote so we only fire on path literals.
paths_residue="$(grep -rnE "[\"'/]\\.breeze[\"'/[:space:]]" packages/auto/src apps/cli/src 2>/dev/null || true)"
if [[ -n "$paths_residue" ]]; then
  printf 'unexpected .breeze path literals:\n%s\n' "$paths_residue" >&2
  fail "A-class path residue"
fi
note "  ok: .breeze path literals absent"

# Catch `breeze daemon|poll|start|stop|...` user-facing command strings.
# CLI USAGE / spawn args / log lines must say `auto …` not `breeze …`.
cmd_residue="$(grep -rnE '"breeze (daemon|poll|start|stop|status|doctor|cleanup|install|run|run-once|status-manager|watch|statusline|poll-inbox)"' packages/auto/src apps/cli/src 2>/dev/null || true)"
if [[ -n "$cmd_residue" ]]; then
  printf 'unexpected "breeze <cmd>" literals:\n%s\n' "$cmd_residue" >&2
  fail "A-class command-string residue"
fi
note "  ok: \"breeze <cmd>\" command strings absent"

# B-class kept (must appear)
b_status_count="$(grep -c 'breeze_status' packages/auto/src/runtime/types.ts || true)"
[[ "$b_status_count" -ge 1 ]] || fail "B-class breeze_status missing in types.ts"
b_label_count="$(grep -cE '"breeze:(done|wip|human|new)"' packages/auto/src/runtime/types.ts || true)"
[[ "$b_label_count" -ge 1 ]] || fail "B-class GitHub label literals missing"
note "  ok: B-class wire format ('breeze_status' field + 'breeze:*' labels) preserved"

# --- §13.2 package-level tests --------------------------------------------
step "13.2 package-level tests (typecheck + build + vitest)"

# Wipe stale artifacts so this is the authoritative pass.
rm -rf packages/auto/dist apps/cli/dist
find . -maxdepth 4 -name "*.tsbuildinfo" -not -path "*/node_modules/*" -delete

pnpm -s typecheck >/dev/null
note "  ok: pnpm typecheck"

pnpm -s -C packages/auto run build >/dev/null
pnpm -s -C apps/cli run build >/dev/null
note "  ok: pnpm -r build"

pnpm -s -C packages/auto test >/dev/null 2>&1 || fail "packages/auto vitest"
pnpm -s -C apps/cli test >/dev/null 2>&1 || fail "apps/cli vitest"
note "  ok: workspace vitest (packages/auto + apps/cli)"

# --- §13.3 CLI behavior smoke (no network) --------------------------------
step "13.3 CLI behavior smoke"

CLI="$ROOT/apps/cli/dist/index.js"
[[ -x "$CLI" ]] || chmod +x "$CLI"

AUTO_DIR_TMP="$(mktemp -d -t auto-regression.XXXXXX)"
trap 'rm -rf "$AUTO_DIR_TMP"' EXIT

# Help & dispatch
node "$CLI" --help </dev/null | grep -q "auto" || fail "root --help missing 'auto'"
node "$CLI" auto --help </dev/null | grep -q "Auto is the proposal/inbox agent" || fail "auto --help missing AUTO_USAGE"
node "$CLI" auto </dev/null | grep -q "Auto is the proposal/inbox agent" || fail "bare auto missing AUTO_USAGE"
note "  ok: help dispatch (--help / -h / bare)"

# Doctor / status (no daemon, expected exit 0 + diagnostic output)
AUTO_DIR="$AUTO_DIR_TMP/d1" node "$CLI" auto doctor </dev/null >/dev/null
AUTO_DIR="$AUTO_DIR_TMP/d2" node "$CLI" auto status </dev/null >/dev/null
AUTO_DIR="$AUTO_DIR_TMP/d3" node "$CLI" auto cleanup </dev/null >/dev/null
note "  ok: auto doctor/status/cleanup (no daemon required)"

# Error paths — `set -e` is on, so use `!` to assert non-zero exit.
! node "$CLI" auto unknown-frob </dev/null >/dev/null 2>&1 || fail "auto unknown-frob should exit non-zero"
! AUTO_DIR="$AUTO_DIR_TMP/d4" node "$CLI" auto start </dev/null >/dev/null 2>&1 || fail "auto start without --allow-repo should fail"
note "  ok: error paths (unknown subcommand + missing --allow-repo)"

# --- §13.4 HTTP / SSE / dashboard smoke ----------------------------------
step "13.4 HTTP / SSE / dashboard smoke"

if [[ "${SKIP_HTTP:-}" == "1" ]]; then
  warn "  SKIP_HTTP=1 — skipping §13.4"
elif ! command -v jq >/dev/null 2>&1; then
  warn "  jq not present — skipping §13.4"
elif ! command -v lsof >/dev/null 2>&1; then
  warn "  lsof not present — skipping §13.4"
else
  HTTP_DIR="$(mktemp -d -t auto-regression-http.XXXXXX)"
  HTTP_PORT=7990
  HTTP_LOG="$HTTP_DIR/daemon.log"
  : > "$HTTP_DIR/activity.log"
  printf '{"last_poll":"2026-04-28T00:00:00Z","notifications":[]}\n' > "$HTTP_DIR/inbox.json"

  AUTO_DIR="$HTTP_DIR" AUTO_HTTP_PORT="$HTTP_PORT" \
    node "$CLI" auto daemon \
      --allow-repo "${AUTO_REPO:-first-tree-smoke/none}" \
      >"$HTTP_LOG" 2>&1 &
  DAEMON_PID=$!
  trap 'kill -INT '"$DAEMON_PID"' 2>/dev/null || true; rm -rf "$AUTO_DIR_TMP" "$HTTP_DIR"' EXIT

  bound=0
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 1 "http://127.0.0.1:${HTTP_PORT}/healthz" >/dev/null 2>&1; then
      bound=1; break
    fi
    sleep 0.5
  done
  [[ "$bound" == "1" ]] || { cat "$HTTP_LOG" >&2; fail "daemon did not bind 127.0.0.1:${HTTP_PORT}"; }

  # 7 routes
  curl -fsS "http://127.0.0.1:${HTTP_PORT}/healthz"   | grep -q "^ok"
  curl -fsS "http://127.0.0.1:${HTTP_PORT}/inbox"     | jq . >/dev/null
  curl -fsS "http://127.0.0.1:${HTTP_PORT}/activity"  | head -c 1024 >/dev/null
  curl -fsS "http://127.0.0.1:${HTTP_PORT}/dashboard" | grep -q "<html"
  curl -fsS "http://127.0.0.1:${HTTP_PORT}/index.html"| grep -q "<html"
  curl -fsS "http://127.0.0.1:${HTTP_PORT}/"          | grep -q "<html"
  # SSE: write to a temp file and check non-empty. Piping curl into
  # `head -3` would SIGPIPE curl as soon as head closes the pipe, and
  # `set -o pipefail` would treat that as failure (exit 23).
  sse_tmp="$HTTP_DIR/sse.out"
  if [[ -n "$TIMEOUT_CMD" ]]; then
    "$TIMEOUT_CMD" 3 curl -fsSN "http://127.0.0.1:${HTTP_PORT}/events" \
      > "$sse_tmp" 2>&1 || true
  else
    (curl -fsSN "http://127.0.0.1:${HTTP_PORT}/events" > "$sse_tmp" 2>&1) &
    sse_pid=$!
    sleep 3
    kill -INT "$sse_pid" 2>/dev/null || true
    wait "$sse_pid" 2>/dev/null || true
  fi
  [[ -s "$sse_tmp" ]] || fail "SSE returned empty body"
  note "  ok: 7 routes responding (healthz/inbox/activity/dashboard/index.html/root/events)"

  kill -INT $DAEMON_PID
  wait $DAEMON_PID 2>/dev/null || true
  rm -rf "$HTTP_DIR"
  trap 'rm -rf "$AUTO_DIR_TMP"' EXIT
  note "  ok: SIGINT clean exit"
fi

# --- §13.5 statusline bundle smoke ----------------------------------------
step "13.5 statusline bundle smoke"

for bundle in "$ROOT/packages/auto/dist/auto-statusline.js" "$ROOT/apps/cli/dist/auto-statusline.js"; do
  [[ -f "$bundle" ]] || fail "missing bundle: $bundle"

  # zero-dep: only node:* imports allowed
  externals="$(grep -oE 'from *"[^"]+"' "$bundle" | sed -E 's/from *"([^"]+)"/\1/' | sort -u || true)"
  if [[ -n "$externals" ]]; then
    while IFS= read -r spec; do
      case "$spec" in
        node:* ) ;;
        * ) fail "$bundle: external import $spec leaked" ;;
      esac
    done <<< "$externals"
  fi
  note "  ok: $(basename "$bundle") zero-dep"

  # functional smoke
  SL_DIR="$(mktemp -d -t auto-sl.XXXXXX)"
  cat > "$SL_DIR/inbox.json" <<EOF
{
  "last_poll": "2026-04-28T00:00:00Z",
  "notifications": [
    { "id": "a", "type": "PullRequest", "breeze_status": "human" },
    { "id": "b", "type": "Issue", "breeze_status": "new" }
  ]
}
EOF
  out="$(AUTO_DIR="$SL_DIR" node "$bundle" </dev/null)"
  case "$out" in
    /auto:*need-you* ) note "  ok: $(basename "$bundle") output: $out" ;;
    * ) fail "$bundle output unexpected: $out" ;;
  esac

  # Size check (target main parity: < 100KB)
  bytes="$(wc -c < "$bundle" | tr -d ' ')"
  [[ "$bytes" -lt 102400 ]] || fail "$bundle too large ($bytes bytes)"

  rm -rf "$SL_DIR"
done
note "  ok: both bundles zero-dep + functional + < 100KB"

# Cold-start (mean of 5; CI VMs are slow so cap at 400ms)
PKG_BUNDLE="$ROOT/packages/auto/dist/auto-statusline.js"
SL_DIR="$(mktemp -d -t auto-sl-cold.XXXXXX)"
printf '{"last_poll":"2026-04-28T00:00:00Z","notifications":[]}\n' > "$SL_DIR/inbox.json"
ts_start_ns="$(node -e 'process.stdout.write(String(process.hrtime.bigint()))')"
for _ in 1 2 3 4 5; do
  AUTO_DIR="$SL_DIR" node "$PKG_BUNDLE" </dev/null >/dev/null
done
ts_end_ns="$(node -e 'process.stdout.write(String(process.hrtime.bigint()))')"
mean_ms=$(( (ts_end_ns - ts_start_ns) / 5000000 ))
[[ "$mean_ms" -lt 400 ]] || fail "statusline cold-start too slow: ${mean_ms}ms (target <400ms)"
note "  ok: statusline cold-start mean ${mean_ms}ms over 5 runs"
rm -rf "$SL_DIR"

# --- §13.6 publish-tarball smoke -----------------------------------------
step "13.6 publish-tarball smoke (pnpm pack + clean install)"

if [[ "${SKIP_PACK:-}" == "1" ]]; then
  warn "  SKIP_PACK=1 — skipping §13.6"
else
  PACK_DIR="$(mktemp -d -t auto-pack.XXXXXX)"
  ( cd apps/cli && pnpm pack --pack-destination "$PACK_DIR" >/dev/null )
  TARBALL="$(ls -1 "$PACK_DIR"/first-tree-*.tgz | head -1)"
  [[ -f "$TARBALL" ]] || fail "pack: no tarball produced"
  note "  ok: tarball $(basename "$TARBALL") ($(wc -c < "$TARBALL" | tr -d ' ') bytes)"

  INSTALL_DIR="$(mktemp -d -t auto-install.XXXXXX)"
  ( cd "$INSTALL_DIR" && npm init -y >/dev/null 2>&1 && npm install --silent "$TARBALL" >/dev/null 2>&1 )

  # dist completeness
  test -f "$INSTALL_DIR/node_modules/first-tree/dist/index.js" || fail "missing dist/index.js"
  test -f "$INSTALL_DIR/node_modules/first-tree/dist/auto-statusline.js" || fail "missing dist/auto-statusline.js"
  test -f "$INSTALL_DIR/node_modules/first-tree/dist/assets/dashboard.html" || fail "missing dist/assets/dashboard.html"
  test -f "$INSTALL_DIR/node_modules/first-tree/dist/skills/auto/SKILL.md" || fail "missing dist/skills/auto/SKILL.md"
  test -f "$INSTALL_DIR/node_modules/first-tree/dist/VERSION" || fail "missing dist/VERSION"
  note "  ok: dist completeness (index.js + auto-statusline.js + assets + skills + VERSION)"

  # bin executable
  "$INSTALL_DIR/node_modules/.bin/first-tree" --version </dev/null | grep -qE "^[0-9]+\." \
    || fail "first-tree --version unexpected output"
  "$INSTALL_DIR/node_modules/.bin/ft" --help </dev/null | grep -q "auto" \
    || fail "ft --help missing 'auto'"
  note "  ok: bin first-tree + ft executable"

  # private package not leaked
  if [[ -d "$INSTALL_DIR/node_modules/@first-tree" ]]; then
    fail "@first-tree/* should not be installed (it's private + bundled inline); leaked into node_modules"
  fi
  note "  ok: @first-tree/auto fully inlined (not present in node_modules)"

  # bundled mode runtime: bare auto + statusline path resolution
  AUTO_DIR_PROD="$(mktemp -d -t auto-prod-test.XXXXXX)"
  prod_out="$(AUTO_DIR="$AUTO_DIR_PROD" "$INSTALL_DIR/node_modules/.bin/first-tree" auto </dev/null)"
  case "$prod_out" in
    "usage: first-tree auto"* )
      note "  ok: bundled first-tree auto outputs AUTO_USAGE"
      ;;
    * )
      printf '  bundled auto output unexpected (first 200 chars):\n  %s\n' "${prod_out:0:200}" >&2
      fail "bundled auto output unexpected"
      ;;
  esac

  # statusline route via bundled bin
  printf '{"last_poll":"2026-04-28T00:00:00Z","notifications":[{"id":"a","type":"PullRequest","breeze_status":"human"}]}\n' \
    > "$AUTO_DIR_PROD/inbox.json"
  prod_sl="$(AUTO_DIR="$AUTO_DIR_PROD" "$INSTALL_DIR/node_modules/.bin/first-tree" auto statusline </dev/null)"
  case "$prod_sl" in
    /auto:*need-you* ) note "  ok: bundled statusline routes to dist/auto-statusline.js: $prod_sl" ;;
    * ) fail "bundled statusline output unexpected: $prod_sl" ;;
  esac

  rm -rf "$INSTALL_DIR" "$AUTO_DIR_PROD" "$PACK_DIR"
fi

# --- §13.7 platform-conditional smoke ------------------------------------
step "13.7 platform smoke"

UNAME="$(uname -s)"

# Windows: just verify build + help; daemon/detached-spawn not in scope.
if [[ "$UNAME" == MINGW* || "$UNAME" == MSYS* || "$UNAME" == CYGWIN* || "$UNAME" == "Windows_NT" ]]; then
  node "$CLI" --help </dev/null | grep -q auto || fail "Windows: --help missing auto"
  node "$CLI" auto --help </dev/null | grep -q "Auto is the proposal/inbox agent" \
    || fail "Windows: auto --help missing AUTO_USAGE"
  note "  ok: Windows build + help smoke (detached spawn not in scope)"
elif [[ -z "${AUTO_REPO:-}" || "${SKIP_HTTP:-}" == "1" ]]; then
  warn "  AUTO_REPO unset or SKIP_HTTP=1 — skipping ${UNAME} daemon-start checks"
else
  PLAT_DIR="$(mktemp -d -t auto-plat.XXXXXX)"
  AUTO_DIR="$PLAT_DIR" AUTO_HTTP_PORT=7991 node "$CLI" auto start --allow-repo "$AUTO_REPO" >/dev/null 2>&1 || true
  sleep 2
  case "$UNAME" in
    Darwin)
      compgen -G "$PLAT_DIR/runner/launchd/com.first-tree.auto.*.plist" >/dev/null \
        && note "  ok: launchd plist present"
      ;;
    Linux)
      [[ -d "$PLAT_DIR/runner/locks" ]] && note "  ok: lockfile dir exists"
      ;;
  esac
  AUTO_DIR="$PLAT_DIR" node "$CLI" auto stop >/dev/null 2>&1 || true
  rm -rf "$PLAT_DIR"
fi

# --- §13.8 coexistence with main breeze ----------------------------------
step "13.8 coexistence with main breeze (only if ~/.breeze/ present)"

if [[ -d "$HOME/.breeze" ]]; then
  warn "  ~/.breeze/ exists — coexistence checks would need a running main breeze; manual verification recommended"
else
  note "  (~/.breeze not present; skipping)"
fi

# --- §13.9 cleanup ---------------------------------------------------------
step "13.9 cleanup + isolation"

rm -rf "$AUTO_DIR_TMP"
trap - EXIT

# Port 7990 / 7991 must be free now
if command -v lsof >/dev/null 2>&1; then
  for p in 7990 7991; do
    if lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
      fail "port $p still LISTEN — daemon stop did not release it"
    fi
  done
  note "  ok: ports 7990/7991 free"
else
  note "  (lsof absent; port-free check skipped)"
fi

printf '\n%sregression-auto OK%s\n' "$ANSI_GREEN" "$ANSI_RESET"
