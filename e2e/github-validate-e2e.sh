#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FT_CLI="${FT_CLI:-$ROOT_DIR/apps/cli/dist/index.js}"
SOURCE_REPO_URL="${SOURCE_REPO_URL:-https://github.com/bingran-you/mews.git}"
ONBOARDING_AGENT_PROMPT="${ONBOARDING_AGENT_PROMPT:-Use the latest First-Tree CLI to install the skill in the current repository and complete the onboarding process by running /first-tree-onboarding skill and build an initial version of tree using /first-tree-sync skill}"
WORK_ROOT="${WORK_ROOT:-}"
WORK_ROOT_CREATED=0
KEEP_WORK_ROOT="${KEEP_WORK_ROOT:-0}"
TREE_REPO_VISIBILITY="${TREE_REPO_VISIBILITY:-private}"
TREE_REPO_SLUG="${TREE_REPO_SLUG:-}"
DELETE_TREE_REPO="${DELETE_TREE_REPO:-0}"
AGENT_E2E_TOOL="${AGENT_E2E_TOOL:-codex}"
AGENT_TIMEOUT_SECS="${AGENT_TIMEOUT_SECS:-420}"
USE_AGENT_ONBOARDING="${USE_AGENT_ONBOARDING:-0}"
RUN_FAILURE_PATH="${RUN_FAILURE_PATH:-0}"
CHECK_POLL_ATTEMPTS="${CHECK_POLL_ATTEMPTS:-60}"
CHECK_POLL_INTERVAL_SECS="${CHECK_POLL_INTERVAL_SECS:-5}"

log() {
  printf '[github-validate-e2e] %s\n' "$*"
}

fail() {
  printf '[github-validate-e2e] ERROR: %s\n' "$*" >&2
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

cleanup() {
  if [[ "$DELETE_TREE_REPO" == "1" && -n "$TREE_REPO_SLUG" ]]; then
    gh repo delete "$TREE_REPO_SLUG" --yes >/dev/null 2>&1 || true
  fi

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
need_cmd gh
need_cmd "$AGENT_E2E_TOOL"

if [[ ! -f "$FT_CLI" ]]; then
  need_cmd pnpm
  log "Building first-tree CLI because $FT_CLI does not exist"
  (
    cd "$ROOT_DIR"
    pnpm build
  )
fi

if [[ -z "$WORK_ROOT" ]]; then
  WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/first-tree-github-validate-e2e.XXXXXX")"
  WORK_ROOT_CREATED=1
else
  mkdir -p "$WORK_ROOT"
fi

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

clone_source_repo() {
  local dest="$1"
  git clone --depth 1 "$SOURCE_REPO_URL" "$dest" >/dev/null
}

check_validate_bucket() {
  local checks_file="$1"
  node -e '
    const fs = require("node:fs");
    let checks = [];
    try {
      const raw = fs.readFileSync(process.argv[1], "utf8").trim();
      checks = raw ? JSON.parse(raw) : [];
    } catch {
      checks = [];
    }
    const validate = Array.isArray(checks)
      ? checks.find((check) => check.name === "validate")
      : undefined;
    process.stdout.write(validate?.bucket ?? "missing");
  ' "$checks_file"
}

wait_for_validate_check() {
  local pr_number="$1"
  local checks_file="$2"
  local bucket

  for ((attempt = 1; attempt <= CHECK_POLL_ATTEMPTS; attempt += 1)); do
    gh pr checks "$pr_number" --repo "$TREE_REPO_SLUG" --json name,bucket >"$checks_file" 2>/dev/null || true
    bucket="$(check_validate_bucket "$checks_file")"

    case "$bucket" in
      pass)
        return 0
        ;;
      fail)
        return 1
        ;;
      pending|missing|skipping|cancel)
        sleep "$CHECK_POLL_INTERVAL_SECS"
        ;;
      *)
        sleep "$CHECK_POLL_INTERVAL_SECS"
        ;;
    esac
  done

  return 1
}

ensure_tree_repo_slug() {
  if [[ -n "$TREE_REPO_SLUG" ]]; then
    return
  fi

  local owner
  local source_name
  owner="$(gh api user -q .login)"
  source_name="$(basename "${SOURCE_REPO_URL%.git}")"
  TREE_REPO_SLUG="${owner}/${source_name}-tree-e2e-$(date +%s)"
}

ensure_tree_remote_repo() {
  ensure_tree_repo_slug

  if gh repo view "$TREE_REPO_SLUG" >/dev/null 2>&1; then
    log "Reusing existing tree repo $TREE_REPO_SLUG"
    return
  fi

  case "$TREE_REPO_VISIBILITY" in
    public|private|internal) ;;
    *) fail "TREE_REPO_VISIBILITY must be public, private, or internal" ;;
  esac

  log "Creating remote tree repo $TREE_REPO_SLUG ($TREE_REPO_VISIBILITY)"
  gh repo create "$TREE_REPO_SLUG" "--$TREE_REPO_VISIBILITY" \
    --description "Temporary first-tree validate e2e for $SOURCE_REPO_URL" >/dev/null
}

run_agent_onboarding() {
  local repo_root="$1"
  local output_file="$2"
  local agent_exit_code

  case "$AGENT_E2E_TOOL" in
    codex)
      set +e
      run_with_timeout "$AGENT_TIMEOUT_SECS" "$output_file" \
        codex exec \
        --cd "$repo_root" \
        --dangerously-bypass-approvals-and-sandbox \
        "$(agent_prompt)"
      agent_exit_code=$?
      set -e
      ;;
    claude)
      set +e
      run_with_timeout "$AGENT_TIMEOUT_SECS" "$output_file" \
        claude -p \
        --permission-mode bypassPermissions \
        "$(agent_prompt)"
      agent_exit_code=$?
      set -e
      ;;
    *)
      fail "unsupported AGENT_E2E_TOOL=$AGENT_E2E_TOOL"
      ;;
  esac

  if [[ "$agent_exit_code" -ne 0 && "$agent_exit_code" -ne 124 ]]; then
    fail "$AGENT_E2E_TOOL prompt run exited with status $agent_exit_code"
  fi
}

run_live_validate_flow() {
  local source_name workspace_root repo_root tree_root tree_name output_file init_json status_after verify_json
  local branch_name pr_number checks_json remote_url
  source_name="$(basename "${SOURCE_REPO_URL%.git}")"
  workspace_root="$WORK_ROOT/${source_name}-workspace"
  repo_root="$workspace_root/$source_name"
  output_file="$WORK_ROOT/agent-output.txt"
  init_json="$WORK_ROOT/init.json"
  status_after="$WORK_ROOT/status-after.json"
  verify_json="$WORK_ROOT/verify.json"

  mkdir -p "$workspace_root"
  clone_source_repo "$repo_root"
  (
    cd "$repo_root"
    git checkout -b "e2e/first-tree-onboarding-$(date +%s)" >/dev/null
  )

  if [[ "$USE_AGENT_ONBOARDING" == "1" ]]; then
    log "Running agent onboarding prompt in $repo_root"
    run_agent_onboarding "$repo_root" "$output_file"

    (
      cd "$repo_root"
      node "$FT_CLI" tree status --json >"$status_after"
    )
    workspace_root="$(json_value "$status_after" workspaceRoot)"
    [[ -n "$workspace_root" ]] || fail "expected status to report a workspaceRoot after onboarding"
    tree_name="$(json_query "$status_after" manifest.tree)"
    [[ -n "$tree_name" ]] || fail "manifest.tree missing after onboarding"
    tree_root="$workspace_root/$tree_name"
    [[ -d "$tree_root" ]] || fail "expected tree root at $tree_root"

    (
      cd "$repo_root"
      node "$FT_CLI" tree verify --json --tree-path "$tree_root" >"$verify_json"
    )
    [[ "$(json_value "$verify_json" ok)" == "true" ]] || fail "tree verify did not report ok=true"
    [[ -f "$tree_root/.github/workflows/validate.yml" ]] || fail "validate workflow missing from tree repo"
    head -n 1 "$tree_root/.github/workflows/validate.yml" | grep -qx '# first-tree-template-version: 2' || fail "validate workflow missing managed template marker"
    ! grep -Fq "The living source of truth for your organization" "$tree_root/NODE.md" || fail "root placeholder content still present after onboarding"
    ! grep -Fq "Default bootstrap member node" "$tree_root/members/owner/NODE.md" || fail "default member placeholder still present after onboarding"
    [[ -s "$output_file" ]] || fail "agent onboarding did not produce any captured output"
  else
    log "Running direct CLI onboarding in $workspace_root"
    (
      cd "$workspace_root"
      node "$FT_CLI" tree skill install --root "$workspace_root" >/dev/null
      node "$FT_CLI" tree init --json --scope workspace --tree-path "./${source_name}-tree" --tree-mode dedicated >"$init_json"
      tree_root="$(json_value "$init_json" treeRoot)"
      [[ -n "$tree_root" ]] || fail "tree init did not report a treeRoot"
      node "$FT_CLI" tree status --json >"$status_after"
      [[ "$(json_value "$status_after" workspaceRoot)" == "$workspace_root" ]] || fail "expected status to report workspaceRoot=$workspace_root after tree init"
      node "$FT_CLI" tree verify --json --tree-path "$tree_root" >"$verify_json"
      [[ "$(json_value "$verify_json" ok)" == "true" ]] || fail "tree verify did not report ok=true"
      [[ -f "$tree_root/.github/workflows/validate.yml" ]] || fail "validate workflow missing from tree repo"
      head -n 1 "$tree_root/.github/workflows/validate.yml" | grep -qx '# first-tree-template-version: 2' || fail "validate workflow missing managed template marker"
    )
    tree_root="$(json_value "$init_json" treeRoot)"
  fi

  ensure_tree_remote_repo
  remote_url="$(gh repo view "$TREE_REPO_SLUG" --json url -q .url)"

  (
    cd "$tree_root"
    git branch -M main
    if git remote get-url origin >/dev/null 2>&1; then
      git remote set-url origin "$remote_url"
    else
      git remote add origin "$remote_url"
    fi
    git add -A
    git commit -m "e2e: first-tree onboarding" >/dev/null
    git push -u origin main >/dev/null

    branch_name="e2e/validate-check-$(date +%s)"
    git checkout -b "$branch_name" >/dev/null
    printf '\n<!-- e2e validate check -->\n' >> NODE.md
    git add NODE.md
    git commit -m "e2e: trigger validate" >/dev/null
    git push -u origin "$branch_name" >/dev/null

    gh pr create --repo "$TREE_REPO_SLUG" \
      --head "$branch_name" \
      --base main \
      --title "e2e: validate workflow" \
      --body "Trigger the validate workflow from the live onboarding e2e." >/dev/null
    pr_number="$(gh pr list --repo "$TREE_REPO_SLUG" --head "$branch_name" --json number -q '.[0].number')"
    [[ -n "$pr_number" ]] || fail "could not resolve PR number for branch $branch_name in $TREE_REPO_SLUG"
    wait_for_validate_check "$pr_number" "$WORK_ROOT/pr-checks.json" || fail "validate check did not reach a passing state in time"
  )

  checks_json="$WORK_ROOT/pr-checks.json"
  node -e '
    const fs = require("node:fs");
    const checks = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const validate = checks.find((check) => check.name === "validate");
    if (!validate || validate.bucket !== "pass") {
      process.exit(1);
    }
  ' "$checks_json" || fail "live GitHub PR did not report a passing validate check"

  if [[ "$RUN_FAILURE_PATH" == "1" ]]; then
    log "Running optional failure-path check on the live PR"
    (
      cd "$tree_root"
      printf 'This file has no frontmatter.\n' > broken.md
      git add broken.md
      git commit -m "e2e: break validate" >/dev/null
      git push >/dev/null
      gh pr checks "$pr_number" --repo "$TREE_REPO_SLUG" --watch --required || true
      gh pr checks "$pr_number" --repo "$TREE_REPO_SLUG" --json name,bucket >"$WORK_ROOT/pr-checks-failure.json"
    )
    node -e '
      const fs = require("node:fs");
      const checks = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const validate = checks.find((check) => check.name === "validate");
      if (!validate || validate.bucket !== "fail") {
        process.exit(1);
      }
    ' "$WORK_ROOT/pr-checks-failure.json" || fail "expected validate check to fail after pushing an invalid tree change"
  fi

  log "Live validate e2e passed. Tree repo: $TREE_REPO_SLUG"
}

run_live_validate_flow
