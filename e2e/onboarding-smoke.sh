#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FT_CLI="${FT_CLI:-$ROOT_DIR/apps/cli/dist/index.js}"
TEST_REPO_URL="${TEST_REPO_URL:-https://github.com/bingran-you/sbti-cli.git}"
PROMPT_TEST_REPO_URL="${PROMPT_TEST_REPO_URL:-https://github.com/bingran-you/mews.git}"
KEEP_WORK_ROOT="${KEEP_WORK_ROOT:-0}"
RUN_CODEX_PROMPT_SMOKE="${RUN_CODEX_PROMPT_SMOKE:-auto}"
RUN_CLAUDE_PROMPT_SMOKE="${RUN_CLAUDE_PROMPT_SMOKE:-auto}"
ONBOARDING_AGENT_PROMPT="${ONBOARDING_AGENT_PROMPT:-Use the latest First-Tree CLI to install the skill in the current repository and complete the onboarding process by running /first-tree-onboarding skill and build an initial version of tree using /first-tree-sync skill}"
AGENT_TIMEOUT_SECS="${AGENT_TIMEOUT_SECS:-420}"

WORK_ROOT="${WORK_ROOT:-}"
WORK_ROOT_CREATED=0

log() {
  printf '[onboarding-smoke] %s\n' "$*"
}

fail() {
  printf '[onboarding-smoke] ERROR: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

json_value() {
  local file="$1"
  local key="$2"
  node -e '
    const fs = require("node:fs");
    const [path, field] = process.argv.slice(1);
    const value = JSON.parse(fs.readFileSync(path, "utf8"))[field];
    process.stdout.write(String(value ?? ""));
  ' "$file" "$key"
}

json_query() {
  local file="$1"
  local path="$2"
  node -e '
    const fs = require("node:fs");
    const [jsonPath, query] = process.argv.slice(1);
    const segments = query.split(".");
    let value = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    for (const segment of segments) {
      if (!segment) continue;
      value = value == null ? undefined : value[segment];
    }
    process.stdout.write(String(value ?? ""));
  ' "$file" "$path"
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  if [[ "$haystack" != *"$needle"* ]]; then
    fail "expected output to contain '$needle'"
  fi
}

should_run_prompt_smoke() {
  local mode="$1"
  local tool="$2"

  case "$mode" in
    1|true|TRUE|yes|YES)
      need_cmd "$tool"
      return 0
      ;;
    0|false|FALSE|no|NO)
      return 1
      ;;
    auto|AUTO)
      command -v "$tool" >/dev/null 2>&1
      return $?
      ;;
    *)
      fail "unsupported prompt-smoke mode '$mode' for $tool"
      ;;
  esac
}

cleanup() {
  if [[ "$KEEP_WORK_ROOT" == "1" ]]; then
    log "Keeping work root at $WORK_ROOT"
    return
  fi

  if [[ "$WORK_ROOT_CREATED" == "1" && -n "$WORK_ROOT" ]]; then
    rm -rf "$WORK_ROOT"
  fi
}

trap cleanup EXIT

need_cmd git
need_cmd node

if [[ ! -f "$FT_CLI" ]]; then
  need_cmd pnpm
  log "Building first-tree CLI because $FT_CLI does not exist"
  (
    cd "$ROOT_DIR"
    pnpm build
  )
fi

if [[ -z "$WORK_ROOT" ]]; then
  WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/first-tree-onboarding-smoke.XXXXXX")"
  WORK_ROOT_CREATED=1
else
  mkdir -p "$WORK_ROOT"
fi

clone_repo() {
  local repo_url="$1"
  local dest="$2"
  git clone --depth 1 "$repo_url" "$dest" >/dev/null
}

agent_prompt() {
  cat <<EOF
$ONBOARDING_AGENT_PROMPT

For this eval, the latest CLI under test is available locally at:
$FT_CLI

Use \`node $FT_CLI\` whenever you need the latest build from this checkout.
EOF
}

run_with_timeout() {
  local timeout_secs="$1"
  local output_file="$2"
  shift 2

  node - "$timeout_secs" "$output_file" "$@" <<'JS'
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const [timeoutSeconds, outputPath, ...command] = process.argv.slice(2);
const child = spawn(command[0], command.slice(1), {
  stdio: ["ignore", "pipe", "pipe"],
});
const output = fs.createWriteStream(outputPath, { flags: "w" });
child.stdout.pipe(output);
child.stderr.pipe(output);

let timedOut = false;
const timeoutMs = Number(timeoutSeconds) * 1000;
const timer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 5000).unref();
}, timeoutMs);

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  output.end(() => {
    if (timedOut) {
      process.exit(124);
      return;
    }
    if (signal) {
      process.exit(1);
      return;
    }
    process.exit(code ?? 1);
  });
});
JS
}

run_direct_cli_smoke() {
  local source_name
  local workspace_root
  local repo_root
  local status_after
  local init_json="$WORK_ROOT/direct-cli.init.json"
  local verify_json="$WORK_ROOT/direct-cli.verify.json"
  local automation_json="$WORK_ROOT/direct-cli.automation.json"
  local doctor_json="$WORK_ROOT/direct-cli.skill-doctor.json"
  local tree_root

  source_name="$(basename "${TEST_REPO_URL%.git}")"
  workspace_root="$WORK_ROOT/direct-cli/${source_name}-workspace"
  repo_root="$workspace_root/$source_name"
  status_after="$WORK_ROOT/direct-cli.status-after.json"

  mkdir -p "$workspace_root"
  clone_repo "$TEST_REPO_URL" "$repo_root"

  (
    cd "$workspace_root"
    log "Running direct CLI onboarding smoke in $workspace_root"

    node "$FT_CLI" tree init --json --scope workspace --tree-path "./${source_name}-tree" --tree-mode dedicated >"$init_json"
    tree_root="$(json_value "$init_json" treeRoot)"
    [[ -n "$tree_root" ]] || fail "tree init did not report a treeRoot"

    node "$FT_CLI" tree status --json >"$status_after"
    [[ "$(json_value "$status_after" workspaceRoot)" == "$workspace_root" ]] || fail "expected status to report workspaceRoot=$workspace_root"
    [[ "$(json_query "$status_after" manifest.tree)" == "${source_name}-tree" ]] || fail "expected manifest.tree=${source_name}-tree"

    node "$FT_CLI" tree verify --json --tree-path "$tree_root" >"$verify_json"
    [[ "$(json_value "$verify_json" ok)" == "true" ]] || fail "tree verify did not report ok=true"

    node "$FT_CLI" tree automation install --tier 2 --tree-path "$tree_root" --dry-run --json >"$automation_json"
    [[ "$(json_value "$automation_json" stage)" == "write_rule_layer" ]] || fail "expected tree automation dry-run stage to be write_rule_layer"

    node "$FT_CLI" tree skill doctor --json --root "$workspace_root" >"$doctor_json"

    [[ -f "$workspace_root/AGENTS.md" ]] || fail "workspace root AGENTS.md was not created"
    [[ -f "$workspace_root/CLAUDE.md" ]] || fail "workspace root CLAUDE.md was not created"
    [[ -f "$tree_root/.github/workflows/validate.yml" ]] || fail "validate workflow missing from tree repo"
    [[ -f "$tree_root/.first-tree/org.yaml" ]] || fail "org config placeholder missing from tree repo"
    head -n 1 "$tree_root/.github/workflows/validate.yml" | grep -qx '# first-tree-template-version: 2' || fail "validate workflow missing managed template marker"
    # PR-A: three dead writes must not be scaffolded.
    [[ ! -e "$tree_root/.first-tree/agent-templates" ]] || fail "agent-templates/ dead write should be absent (removed in PR-A)"
    [[ ! -e "$tree_root/WHITEPAPER.md" ]] || fail "tree-root WHITEPAPER.md dead write should be absent (removed in PR-A)"
    [[ ! -e "$tree_root/source-repos.md" ]] || fail "tree-side source-repos.md dead write should be absent (removed in PR-A)"
  )
}

run_codex_prompt_smoke() {
  local repo_root="$WORK_ROOT/prompt-codex/$(basename "${PROMPT_TEST_REPO_URL%.git}")"
  local output_file="$WORK_ROOT/prompt-codex.output.txt"
  local status_after="$WORK_ROOT/prompt-codex.status-after.json"
  local verify_json="$WORK_ROOT/prompt-codex.verify.json"
  local agent_exit_code
  local workspace_root
  local tree_name
  local tree_root

  mkdir -p "$WORK_ROOT/prompt-codex"
  clone_repo "$PROMPT_TEST_REPO_URL" "$repo_root"

  (
    cd "$repo_root"
    log "Running Codex prompt smoke in $repo_root"
    set +e
    run_with_timeout "$AGENT_TIMEOUT_SECS" "$output_file" \
      codex exec \
      --cd "$PWD" \
      --dangerously-bypass-approvals-and-sandbox \
      "$(agent_prompt)"
    agent_exit_code=$?
    set -e
    if [[ "$agent_exit_code" -ne 0 && "$agent_exit_code" -ne 124 ]]; then
      fail "Codex prompt smoke exited with status $agent_exit_code"
    fi
  )

  [[ -f "$output_file" ]] || fail "Codex prompt smoke did not write output"
  (
    cd "$repo_root"
    node "$FT_CLI" tree status --json >"$status_after"
    workspace_root="$(json_value "$status_after" workspaceRoot)"
    [[ -n "$workspace_root" ]] || fail "Codex prompt smoke did not produce a workspaceRoot"
    tree_name="$(json_query "$status_after" manifest.tree)"
    [[ -n "$tree_name" ]] || fail "Codex prompt smoke did not record manifest.tree"
    tree_root="$workspace_root/$tree_name"
    [[ -d "$tree_root" ]] || fail "expected tree root at $tree_root"
    node "$FT_CLI" tree verify --json --tree-path "$tree_root" >"$verify_json"
    [[ "$(json_value "$verify_json" ok)" == "true" ]] || fail "Codex prompt smoke tree verify did not report ok=true"
    [[ -f "$tree_root/.github/workflows/validate.yml" ]] || fail "validate workflow missing after Codex prompt smoke"
    ! grep -Fq "The living source of truth for your organization" "$tree_root/NODE.md" || fail "Codex prompt smoke did not replace root placeholder content"
    ! grep -Fq "Default bootstrap member node" "$tree_root/members/owner/NODE.md" || fail "Codex prompt smoke did not replace default member placeholder"
  )
  assert_contains "$(cat "$output_file")" "Local First Tree onboarding is complete and verified."
  assert_contains "$(cat "$output_file")" "validate.yml"
  assert_contains "$(cat "$output_file")" "Owners gate:"
  assert_contains "$(cat "$output_file")" "tree automation install --tier 2"
}

run_claude_prompt_smoke() {
  local repo_root="$WORK_ROOT/prompt-claude/$(basename "${PROMPT_TEST_REPO_URL%.git}")"
  local output_file="$WORK_ROOT/prompt-claude.output.txt"
  local status_after="$WORK_ROOT/prompt-claude.status-after.json"
  local verify_json="$WORK_ROOT/prompt-claude.verify.json"
  local agent_exit_code
  local workspace_root
  local tree_name
  local tree_root

  mkdir -p "$WORK_ROOT/prompt-claude"
  clone_repo "$PROMPT_TEST_REPO_URL" "$repo_root"

  (
    cd "$repo_root"
    log "Running Claude prompt smoke in $repo_root"
    set +e
    run_with_timeout "$AGENT_TIMEOUT_SECS" "$output_file" \
      claude -p \
      --permission-mode bypassPermissions \
      "$(agent_prompt)"
    agent_exit_code=$?
    set -e
    if [[ "$agent_exit_code" -ne 0 && "$agent_exit_code" -ne 124 ]]; then
      fail "Claude prompt smoke exited with status $agent_exit_code"
    fi
  )

  [[ -f "$output_file" ]] || fail "Claude prompt smoke did not write output"
  (
    cd "$repo_root"
    node "$FT_CLI" tree status --json >"$status_after"
    workspace_root="$(json_value "$status_after" workspaceRoot)"
    [[ -n "$workspace_root" ]] || fail "Claude prompt smoke did not produce a workspaceRoot"
    tree_name="$(json_query "$status_after" manifest.tree)"
    [[ -n "$tree_name" ]] || fail "Claude prompt smoke did not record manifest.tree"
    tree_root="$workspace_root/$tree_name"
    [[ -d "$tree_root" ]] || fail "expected tree root at $tree_root"
    node "$FT_CLI" tree verify --json --tree-path "$tree_root" >"$verify_json"
    [[ "$(json_value "$verify_json" ok)" == "true" ]] || fail "Claude prompt smoke tree verify did not report ok=true"
    [[ -f "$tree_root/.github/workflows/validate.yml" ]] || fail "validate workflow missing after Claude prompt smoke"
    ! grep -Fq "The living source of truth for your organization" "$tree_root/NODE.md" || fail "Claude prompt smoke did not replace root placeholder content"
    ! grep -Fq "Default bootstrap member node" "$tree_root/members/owner/NODE.md" || fail "Claude prompt smoke did not replace default member placeholder"
  )
  assert_contains "$(cat "$output_file")" "Local First Tree onboarding is complete and verified."
  assert_contains "$(cat "$output_file")" "validate.yml"
  assert_contains "$(cat "$output_file")" "Owners gate:"
  assert_contains "$(cat "$output_file")" "tree automation install --tier 2"
}

run_direct_cli_smoke

if should_run_prompt_smoke "$RUN_CODEX_PROMPT_SMOKE" codex; then
  run_codex_prompt_smoke
else
  log "Skipping Codex prompt smoke (RUN_CODEX_PROMPT_SMOKE=$RUN_CODEX_PROMPT_SMOKE)"
fi

if should_run_prompt_smoke "$RUN_CLAUDE_PROMPT_SMOKE" claude; then
  run_claude_prompt_smoke
else
  log "Skipping Claude prompt smoke (RUN_CLAUDE_PROMPT_SMOKE=$RUN_CLAUDE_PROMPT_SMOKE)"
fi

log "All requested onboarding smoke checks passed."
