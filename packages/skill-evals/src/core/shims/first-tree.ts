import { chmodSync } from "node:fs";
import { join } from "node:path";

import { writeText } from "../commands.js";
import { writeShellPathBootstrap } from "../paths.js";
import type { RunPaths } from "../types.js";

export function createFirstTreeShim(
  paths: RunPaths,
  options: {
    modelVerifyMode?: "real" | "shim";
    recordedModelVerifyCwd?: string;
    recordedModelVerifyHead?: string;
    recordedModelVerifyPath?: string;
    auditFixturePath?: string;
    reviewFixturePath?: string;
  } = {},
): void {
  const tsxBin = join(paths.packageRoot, "node_modules", ".bin", "tsx");
  const sourceCliEntry = join(paths.repoRoot, "apps", "cli", "src", "cli", "index.ts");
  const distCliEntry = join(paths.repoRoot, "apps", "cli", "dist", "cli", "index.mjs");
  const shimPath = join(paths.binDir, "first-tree");
  const script = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";

const EVENTS_PATH = process.env.FIRST_TREE_EVAL_EVENTS || ${JSON.stringify(paths.eventsPath)};
const TSX_BIN = ${JSON.stringify(tsxBin)};
const SOURCE_CLI_ENTRY = ${JSON.stringify(sourceCliEntry)};
const DIST_CLI_ENTRY = ${JSON.stringify(distCliEntry)};
const MODEL_VERIFY_MODE = ${JSON.stringify(options.modelVerifyMode ?? "shim")};
const RECORDED_MODEL_VERIFY_CWD = ${JSON.stringify(options.recordedModelVerifyCwd ?? null)};
const RECORDED_MODEL_VERIFY_HEAD = ${JSON.stringify(options.recordedModelVerifyHead ?? null)};
const RECORDED_MODEL_VERIFY_PATH = ${JSON.stringify(options.recordedModelVerifyPath ?? null)};
const AUDIT_FIXTURE_PATH = ${JSON.stringify(options.auditFixturePath ?? null)};
const REVIEW_FIXTURE_PATH = ${JSON.stringify(options.reviewFixturePath ?? null)};

function preview(value) {
  if (!value) return "";
  return value.length <= 4000 ? value : value.slice(0, 4000) + "...<truncated " + (value.length - 4000) + " chars>";
}

function append(event) {
  appendFileSync(EVENTS_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + "\\n", "utf8");
}

function formatArg(arg) {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function commandLine(argv) {
  return argv.map(formatArg).join(" ");
}

function trace(message) {
  if (process.env.FIRST_TREE_EVAL_VERBOSE === "1") {
    const caseId = process.env.FIRST_TREE_EVAL_CASE_ID || "unknown";
    process.stderr.write("[" + caseId + "] " + message + "\\n");
  }
}

function finish(argv, phase, exitCode, stdout, stderr, extra) {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  append({
    type: "first_tree_result",
    phase,
    argv,
    cwd: process.cwd(),
    exitCode,
    signal: null,
    stdoutPreview: preview(stdout),
    stderrPreview: preview(stderr),
    ...extra,
  });
  trace("first-tree result: exit=" + exitCode);
  process.exit(exitCode);
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || null : null;
}

function optionValueWithEquals(argv, name) {
  const exact = optionValue(argv, name);
  if (exact !== null) return exact;
  const prefix = name + "=";
  const value = argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function governanceEvalCaseId() {
  const caseId = process.env.FIRST_TREE_EVAL_CASE_ID || "";
  return caseId === "unbound-github-tree-governance-bootstrap" || caseId === "unbound-github-governance-fail-closed";
}

function runGovernanceTreeInit(argv, phase) {
  const target = resolve(process.cwd(), optionValueWithEquals(argv, "--dir") || "context-tree");
  mkdirSync(join(target, ".first-tree"), { recursive: true });
  writeFileSync(join(target, ".first-tree", "VERSION"), "0.7.0\\n", "utf8");
  writeFileSync(
    join(target, ".first-tree", "tree.json"),
    JSON.stringify({ schemaVersion: 1, treeId: "first-tree-seed-eval", treeMode: "dedicated", treeRepoName: "context-tree" }, null, 2) + "\\n",
    "utf8",
  );
  if (!existsSync(join(target, ".git"))) {
    spawnSync("git", ["init", "--initial-branch=main"], { cwd: target, encoding: "utf8" });
    spawnSync("git", ["config", "user.email", "eval@example.invalid"], { cwd: target, encoding: "utf8" });
    spawnSync("git", ["config", "user.name", "First Tree Eval"], { cwd: target, encoding: "utf8" });
    spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: target, encoding: "utf8" });
    spawnSync("git", ["add", "."], { cwd: target, encoding: "utf8" });
    spawnSync("git", ["commit", "-m", "chore: initialize context tree"], { cwd: target, encoding: "utf8" });
    const origin = target + "-origin.git";
    spawnSync("git", ["clone", "--bare", target, origin], { cwd: process.cwd(), encoding: "utf8" });
    spawnSync("git", ["remote", "add", "origin", origin], { cwd: target, encoding: "utf8" });
    spawnSync("git", ["remote", "set-head", "origin", "main"], { cwd: target, encoding: "utf8" });
  }
  finish(
    argv,
    phase,
    0,
    "Created and bound Context Tree at " + target + "\\nGitHub governance recovery URL: https://github.com/settings/installations/eval\\n",
    "",
    { shimmedByEval: true, governanceTreeInit: true, contextTreePath: target },
  );
}

function treeTreePathArg(argv) {
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-L" || arg === "--level" || arg === "-P" || arg === "--pattern") {
      i += 1;
      continue;
    }
    if (arg === "--no-pull") continue;
    if (!arg.startsWith("-")) return arg;
  }
  return ".";
}

function walkMarkdown(root) {
  const files = [];
  function walk(dir) {
    let entries = [];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === ".git" || entry === "node_modules") continue;
      const child = join(dir, entry);
      let stat;
      try {
        stat = statSync(child);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(child);
        continue;
      }
      if (entry.endsWith(".md")) files.push(child);
    }
  }
  walk(root);
  return files;
}

function patternMatches(value, pattern) {
  if (!pattern) return true;
  const normalized = value.toLowerCase();
  const parts = pattern
    .toLowerCase()
    .split("*")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length === 0 || parts.every((part) => normalized.includes(part));
}

function titleFromMarkdown(path) {
  try {
    const text = readFileSync(path, "utf8");
    const title = text.match(/^title:\\s*"?([^"\\n]+)"?/m)?.[1];
    if (title) return title.trim();
    return text.match(/^#\\s+(.+)$/m)?.[1]?.trim() || basename(path);
  } catch {
    return basename(path);
  }
}

function runTreeTree(argv, phase) {
  if (argv.includes("--help") || argv.includes("-h")) {
    finish(
      argv,
      phase,
      0,
      "Usage: first-tree tree tree [options] [path]\\n\\nBrowse Context Tree nodes as a hierarchy.\\n\\nOptions:\\n  -L, --level <depth>      max descendant depth below the target directory\\n  -P, --pattern <pattern>  shell-style glob filter matched against path, filename, title, and description\\n  --no-pull                skip the automatic git pull refresh\\n  -h, --help               display help for command\\n",
      "",
      { shimmedByEval: true },
    );
  }

  const root = resolve(process.cwd(), treeTreePathArg(argv));
  if (!existsSync(root)) {
    finish(argv, phase, 1, "", "Context Tree path does not exist: " + root + "\\n", { shimmedByEval: true });
  }

  const pattern = optionValue(argv, "-P") || optionValue(argv, "--pattern");
  const rows = [basename(root) + "/ [Context Tree]"];
  for (const file of walkMarkdown(root)) {
    const rel = relative(root, file);
    const title = titleFromMarkdown(file);
    if (!patternMatches(rel + " " + title, pattern)) continue;
    rows.push("- " + rel + " [" + title + "]");
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" });
  const symbolic = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: process.cwd(), encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: process.cwd(), encoding: "utf8" });
  finish(argv, phase, 0, rows.join("\\n") + "\\n", "", {
    actualHead: head.status === 0 ? head.stdout.trim() : null,
    clean: status.status === 0 && status.stdout.trim() === "",
    detachedHead: symbolic.status !== 0,
    shimmedByEval: true,
  });
}

function bodyFromFileOption(argv) {
  const bodyFile = optionValue(argv, "-F") || optionValue(argv, "--file");
  if (!bodyFile) return "";
  try {
    return readFileSync(bodyFile === "-" ? 0 : bodyFile, "utf8");
  } catch {
    return "";
  }
}

function runTreeVerify(argv, phase) {
  const root = resolve(process.cwd(), optionValue(argv, "--tree-path") || ".");
  const errors = [];
  if (!existsSync(root)) errors.push("missing tree root");
  if (!existsSync(join(root, "NODE.md"))) errors.push("missing NODE.md");
  if (!existsSync(join(root, ".first-tree", "VERSION"))) errors.push("missing .first-tree/VERSION");
  if (!existsSync(join(root, ".first-tree", "tree.json"))) errors.push("missing .first-tree/tree.json");
  for (const file of walkMarkdown(root)) {
    if (basename(file) === "AGENTS.md") continue;
    const text = readFileSync(file, "utf8");
    if (!text.startsWith("---")) errors.push(relative(root, file) + " missing frontmatter");
    if (!/^title:/m.test(text)) errors.push(relative(root, file) + " missing title");
    if (!/^owners:\\s*\\[/m.test(text)) errors.push(relative(root, file) + " missing owners");
  }

  if (errors.length > 0) {
    finish(
      argv,
      phase,
      1,
      "Context Tree Verification\\n\\n  Tree root: " + root + "\\n\\n" + errors.map((error) => "  [FAIL] " + error).join("\\n") + "\\n",
      "",
      { shimmedByEval: true },
    );
  }

  finish(
    argv,
    phase,
    0,
    "Context Tree Verification\\n\\n  Tree root: " + root + "\\n\\n  [PASS] framework version\\n  [PASS] tree state\\n  [PASS] root node frontmatter\\n  [PASS] node validation\\n  [PASS] member validation\\n  [PASS] progress checklist\\n\\nAll checks passed.\\n",
    "",
    { shimmedByEval: true },
  );
}

const argv = process.argv.slice(2);
const phase = process.env.FIRST_TREE_EVAL_PHASE || "model";
append({ type: "first_tree_call", phase, argv, cwd: process.cwd() });
trace("first-tree call: " + commandLine(argv));

if (argv[0] === "github" && argv[1] === "context-review" && argv[2] === "submit" && REVIEW_FIXTURE_PATH) {
  const fixture = JSON.parse(readFileSync(REVIEW_FIXTURE_PATH, "utf8"));
  const runId = optionValue(argv, "--run");
  const commitOid = optionValue(argv, "--head");
  const event = optionValue(argv, "--event");
  const bodyFile = optionValue(argv, "--body-file");
  const exactOptions = argv.length === 11;
  const action = event === "APPROVE" ? "approve" : event === "COMMENT" ? "comment" : event === "REQUEST_CHANGES" ? "request-changes" : null;
  let body = "";
  try {
    body = bodyFile && bodyFile !== "-" ? readFileSync(bodyFile, "utf8") : "";
  } catch {}
  const valid = exactOptions && runId === fixture.runId && commitOid === fixture.reviewHeadOid && action && body.length > 0;
  if (!valid) {
    finish(argv, phase, 2, "", "Invalid Context Reviewer App submission fixture.\\n", { blockedByEval: true });
  }
  append({
    type: "context_review_submitted",
    phase,
    action,
    appActor: "first-tree-eval[bot]",
    body,
    bodyFileUsed: true,
    commitOid,
    currentHeadOid: fixture.submissionHeadOid,
    prNumber: fixture.prNumber,
    repo: fixture.repo,
    runId,
  });
  finish(
    argv,
    phase,
    0,
    JSON.stringify({ action: event, reviewedHead: commitOid, reviewId: 4242, reviewUrl: "https://github.com/owner/context-tree/pull/42#pullrequestreview-4242", appActor: "first-tree-eval[bot]" }) + "\\n",
    "",
    { recordedOnly: true },
  );
}

if (argv[0] === "github") {
  const exitCode = 1;
  const stderr = "Blocked first-tree github command in skill eval. No real GitHub side effect was attempted.\\n";
  process.stderr.write(stderr);
  append({
    type: "first_tree_result",
    phase,
    argv,
    cwd: process.cwd(),
    exitCode,
    signal: null,
    stdoutPreview: "",
    stderrPreview: preview(stderr),
    blockedByEval: true,
  });
  trace("first-tree result: exit=1 blocked github command");
  process.exit(exitCode);
}

if (argv[0] === "tree" && argv[1] === "init" && governanceEvalCaseId()) {
  runGovernanceTreeInit(argv, phase);
}

if (argv[0] === "tree" && ["bind", "create", "init", "seed", "setup"].includes(argv[1] || "")) {
  const exitCode = 1;
  const stderr = "Blocked first-tree tree setup command in skill eval. No real tree setup side effect was attempted.\\n";
  process.stderr.write(stderr);
  append({
    type: "first_tree_result",
    phase,
    argv,
    cwd: process.cwd(),
    exitCode,
    signal: null,
    stdoutPreview: "",
    stderrPreview: preview(stderr),
    blockedByEval: true,
  });
  trace("first-tree result: exit=1 blocked tree setup command");
  process.exit(exitCode);
}

if (argv[0] === "chat" && ["ask", "send", "update"].includes(argv[1] || "")) {
  if (AUDIT_FIXTURE_PATH && argv[1] === "ask") {
    const fixture = JSON.parse(readFileSync(AUDIT_FIXTURE_PATH, "utf8"));
    append({
      type: "audit_artifact_created",
      phase,
      artifact: "human-ask",
      argv,
      body: bodyFromFileOption(argv),
      cwd: process.cwd(),
      repo: fixture.repo,
    });
  }
  const exitCode = 0;
  const stdout = "Recorded first-tree chat " + argv[1] + " in skill eval. No real message was sent.\\n";
  process.stdout.write(stdout);
  append({
    type: "first_tree_result",
    phase,
    argv,
    cwd: process.cwd(),
    exitCode,
    signal: null,
    stdoutPreview: preview(stdout),
    stderrPreview: "",
    recordedOnly: true,
  });
  trace("first-tree result: exit=0 recorded-only chat " + argv[1]);
  process.exit(exitCode);
}

if (argv[0] === "tree" && argv[1] === "tree") {
  runTreeTree(argv, phase);
}

if (RECORDED_MODEL_VERIFY_PATH && phase === "model" && argv[0] === "tree" && argv[1] === "verify") {
  const exactCommand = argv.length === 3 && argv[2] === "--json";
  let actualCwd = null;
  let expectedCwd = null;
  try {
    actualCwd = realpathSync(process.cwd());
    expectedCwd = RECORDED_MODEL_VERIFY_CWD ? realpathSync(RECORDED_MODEL_VERIFY_CWD) : null;
  } catch {}
  const headResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" });
  const symbolicHeadResult = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const statusResult = spawnSync("git", ["status", "--porcelain"], { cwd: process.cwd(), encoding: "utf8" });
  const actualHead = headResult.status === 0 ? headResult.stdout.trim() : null;
  const clean = statusResult.status === 0 && statusResult.stdout.trim() === "";
  const verifyBindingValid =
    exactCommand &&
    actualCwd !== null &&
    expectedCwd !== null &&
    actualCwd === expectedCwd &&
    actualHead === RECORDED_MODEL_VERIFY_HEAD &&
    symbolicHeadResult.status !== 0 &&
    clean;
  if (!verifyBindingValid) {
    finish(
      argv,
      phase,
      2,
      "",
      "Recorded validator replay requires the registered clean detached PR-head worktree and exact 'tree verify --json' command.\\n",
      {
        actualHead,
        expectedHead: RECORDED_MODEL_VERIFY_HEAD,
        recordedRealVerify: false,
        verifyBindingValid: false,
      },
    );
  }
  const recorded = JSON.parse(readFileSync(RECORDED_MODEL_VERIFY_PATH, "utf8"));
  let auditOriginAdvanced = false;
  if (AUDIT_FIXTURE_PATH) {
    const fixture = JSON.parse(readFileSync(AUDIT_FIXTURE_PATH, "utf8"));
    if (fixture.scenario === "stale-before-write" && fixture.originPath && fixture.advancedHeadOid) {
      const advanced = spawnSync(
        "git",
        ["--git-dir", fixture.originPath, "update-ref", "refs/heads/main", fixture.advancedHeadOid, fixture.headOid],
        { encoding: "utf8" },
      );
      auditOriginAdvanced = advanced.status === 0;
      if (!auditOriginAdvanced) {
        finish(argv, phase, 2, "", "Failed to advance the deterministic audit origin.\\n", {
          auditOriginAdvanced: false,
          recordedRealVerify: false,
          verifyBindingValid: true,
        });
      }
    }
  }
  let stdout = recorded.stdout;
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === "object") parsed.targetRoot = process.cwd();
    stdout = JSON.stringify(parsed) + "\\n";
  } catch {}
  finish(argv, phase, recorded.exitCode, stdout, recorded.stderr, {
    actualHead,
    auditOriginAdvanced,
    recordedRealVerify: true,
    verifyBindingValid: true,
  });
}

if (MODEL_VERIFY_MODE === "shim" && phase === "model" && argv[0] === "tree" && argv[1] === "verify") {
  runTreeVerify(argv, phase);
}

const hasDistCli = existsSync(DIST_CLI_ENTRY);
const realCommand = process.env.FIRST_TREE_EVAL_REAL_FIRST_TREE || (hasDistCli ? process.execPath : TSX_BIN);
const realArgs = process.env.FIRST_TREE_EVAL_REAL_FIRST_TREE
  ? argv
  : hasDistCli
    ? [DIST_CLI_ENTRY, ...argv]
    : [SOURCE_CLI_ENTRY, ...argv];
const result = spawnSync(realCommand, realArgs, {
  cwd: process.cwd(),
  encoding: "utf8",
  env: process.env,
  maxBuffer: 20 * 1024 * 1024,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.error) {
  append({
    type: "first_tree_result",
    phase,
    argv,
    cwd: process.cwd(),
    exitCode: 127,
    error: String(result.error),
    stdoutPreview: preview(result.stdout || ""),
    stderrPreview: preview(result.stderr || ""),
  });
  trace("first-tree result: exit=127 error=" + preview(String(result.error)));
  process.exit(127);
}

const exitCode = result.status == null ? 1 : result.status;
append({
  type: "first_tree_result",
  phase,
  argv,
  cwd: process.cwd(),
  exitCode,
  signal: result.signal || null,
  stdoutPreview: preview(result.stdout || ""),
  stderrPreview: preview(result.stderr || ""),
});
trace("first-tree result: exit=" + exitCode);

process.exit(exitCode);
`;

  writeText(shimPath, script);
  chmodSync(shimPath, 0o755);
  writeShellPathBootstrap(paths);
}
