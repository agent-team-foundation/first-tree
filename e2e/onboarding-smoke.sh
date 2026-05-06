#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FT_CLI="${FT_CLI:-$ROOT_DIR/apps/cli/dist/index.js}"
TEST_REPO_URL="${TEST_REPO_URL:-https://github.com/bingran-you/sbti-cli.git}"
KEEP_WORK_ROOT="${KEEP_WORK_ROOT:-0}"
RUN_CODEX_PROMPT_SMOKE="${RUN_CODEX_PROMPT_SMOKE:-auto}"
RUN_CLAUDE_PROMPT_SMOKE="${RUN_CLAUDE_PROMPT_SMOKE:-auto}"

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
    pnpm --filter first-tree build
  )
fi

if [[ -z "$WORK_ROOT" ]]; then
  WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/first-tree-onboarding-smoke.XXXXXX")"
  WORK_ROOT_CREATED=1
else
  mkdir -p "$WORK_ROOT"
fi

clone_repo() {
  local dest="$1"
  git clone --depth 1 "$TEST_REPO_URL" "$dest" >/dev/null
}

run_direct_cli_smoke() {
  local repo_root="$WORK_ROOT/direct-cli/sbti-cli"
  local inspect_before="$WORK_ROOT/direct-cli.inspect-before.json"
  local init_json="$WORK_ROOT/direct-cli.init.json"
  local inspect_after="$WORK_ROOT/direct-cli.inspect-after.json"
  local verify_json="$WORK_ROOT/direct-cli.verify.json"
  local doctor_json="$WORK_ROOT/direct-cli.skill-doctor.json"
  local tree_root
  local role

  mkdir -p "$WORK_ROOT/direct-cli"
  clone_repo "$repo_root"

  (
    cd "$repo_root"
    log "Running direct CLI onboarding smoke in $repo_root"
    node "$FT_CLI" tree inspect --json >"$inspect_before"
    role="$(json_value "$inspect_before" role)"
    [[ "$role" == "unbound-source-repo" ]] || fail "expected pre-init role to be unbound-source-repo, got $role"

    node "$FT_CLI" tree init --json --no-recursive >"$init_json"
    tree_root="$(json_value "$init_json" treeRoot)"
    [[ -n "$tree_root" ]] || fail "tree init did not report a treeRoot"

    node "$FT_CLI" tree inspect --json >"$inspect_after"
    role="$(json_value "$inspect_after" role)"
    [[ "$role" == "source-repo-bound" ]] || fail "expected post-init role to be source-repo-bound, got $role"

    node "$FT_CLI" tree verify --json --tree-path "$tree_root" >"$verify_json"
    [[ "$(json_value "$verify_json" ok)" == "true" ]] || fail "tree verify did not report ok=true"

    node "$FT_CLI" tree skill doctor --json --root "$repo_root" >"$doctor_json"

    [[ -f "$repo_root/AGENTS.md" ]] || fail "source repo AGENTS.md was not created"
    [[ -f "$repo_root/CLAUDE.md" ]] || fail "source repo CLAUDE.md was not created"
    [[ -f "$tree_root/.first-tree/agent-templates/developer.yaml" ]] || fail "developer template missing from tree repo"
    [[ -f "$tree_root/.first-tree/agent-templates/code-reviewer.yaml" ]] || fail "code-reviewer template missing from tree repo"
    [[ -f "$tree_root/.first-tree/org.yaml" ]] || fail "org config placeholder missing from tree repo"
  )
}

run_codex_prompt_smoke() {
  local repo_root="$WORK_ROOT/prompt-codex/sbti-cli"
  local last_message="$WORK_ROOT/prompt-codex.last-message.txt"

  mkdir -p "$WORK_ROOT/prompt-codex"
  clone_repo "$repo_root"

  (
    cd "$repo_root"
    log "Running Codex prompt smoke in $repo_root"
    codex exec \
      --cd "$PWD" \
      --dangerously-bypass-approvals-and-sandbox \
      --output-last-message "$last_message" \
      "Use the first-tree CLI at $FT_CLI. Run \`node $FT_CLI tree inspect --json\` and tell me the detected role only."
  )

  [[ -f "$last_message" ]] || fail "Codex prompt smoke did not write a last-message file"
  assert_contains "$(cat "$last_message")" "unbound-source-repo"
}

run_claude_prompt_smoke() {
  local repo_root="$WORK_ROOT/prompt-claude/sbti-cli"
  local output_file="$WORK_ROOT/prompt-claude.output.txt"

  mkdir -p "$WORK_ROOT/prompt-claude"
  clone_repo "$repo_root"

  (
    cd "$repo_root"
    log "Running Claude prompt smoke in $repo_root"
    claude -p \
      --permission-mode bypassPermissions \
      "Use the first-tree CLI at $FT_CLI. Run \`node $FT_CLI tree inspect --json\` and tell me the detected role only." \
      >"$output_file"
  )

  [[ -f "$output_file" ]] || fail "Claude prompt smoke did not write output"
  assert_contains "$(cat "$output_file")" "unbound-source-repo"
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
