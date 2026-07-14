import { chmodSync } from "node:fs";
import { join } from "node:path";

import { writeText } from "../commands.js";
import { writeShellPathBootstrap } from "../paths.js";
import type { RunPaths } from "../types.js";

export function createGhShim(paths: RunPaths): void {
  const shimPath = join(paths.binDir, "gh");
  const script = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const EVENTS_PATH = process.env.FIRST_TREE_EVAL_EVENTS || ${JSON.stringify(paths.eventsPath)};

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

function finish(argv, phase, exitCode, stdout, stderr, extra = {}) {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  append({
    type: "gh_result",
    phase,
    argv,
    cwd: process.cwd(),
    exitCode,
    signal: null,
    stdoutPreview: preview(stdout),
    stderrPreview: preview(stderr),
    ...extra,
  });
  trace("gh result: exit=" + exitCode + " " + commandLine(argv));
  process.exit(exitCode);
}

function argAfter(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || "" : "";
}

function ghMethod(argv) {
  return argAfter(argv, "-X") || argAfter(argv, "--method") || "GET";
}

function endpointArg(argv) {
  if (argv[0] !== "api") return "";
  return argv.find((arg, index) => index > 0 && !arg.startsWith("-") && argv[index - 1] !== "--jq" && argv[index - 1] !== "--input" && argv[index - 1] !== "-X" && argv[index - 1] !== "--method") || "";
}

function isGovernanceBootstrapCase() {
  return (process.env.FIRST_TREE_EVAL_CASE_ID || "") === "unbound-github-tree-governance-bootstrap";
}

function isGovernanceRecoveryCase() {
  return (process.env.FIRST_TREE_EVAL_CASE_ID || "") === "unbound-github-governance-fail-closed";
}

function encodedCodeowners() {
  return Buffer.from("* @agent-team-foundation/context-maintainers\\n", "utf8").toString("base64") + "\\n";
}

function bootstrapResponse(argv) {
  const endpoint = endpointArg(argv);
  const method = ghMethod(argv);
  if (argv[0] === "repo" && argv[1] === "view") {
    const jq = argAfter(argv, "--jq");
    if (jq === ".nameWithOwner") return { stdout: "agent-team-foundation/context-tree\\n" };
    if (jq === ".defaultBranchRef.name") return { stdout: "main\\n" };
    return { stdout: '{"nameWithOwner":"agent-team-foundation/context-tree","defaultBranchRef":{"name":"main"}}\\n' };
  }
  if (argv[0] !== "api") return null;
  if (endpoint === "user") return { stdout: "seed-author\\n" };
  if (endpoint === "repos/$repo" || endpoint === "repos/agent-team-foundation/context-tree") return { stdout: "Organization\\n" };
  if (endpoint === "repos/$repo/teams?per_page=100") return { stdout: "context-maintainers\\n" };
  if (endpoint === "orgs/$repo_owner/teams/$candidate_team_slug/members?per_page=100") return { stdout: "tree-reviewer\\n" };
  if (endpoint === "repos/$repo/collaborators?affiliation=direct&permission=push&per_page=100") return { stdout: "tree-reviewer\\n" };
  if (endpoint === "repos/$repo/contents/.github/CODEOWNERS?ref=$default_branch") return { stdout: encodedCodeowners() };
  if (endpoint === "repos/$repo/codeowners/errors?ref=$default_branch") return { stdout: "0\\n" };
  if (endpoint === "repos/$repo/rulesets?includes_parents=false&per_page=100") return { stdout: "\\n" };
  if ((endpoint === "repos/$repo/rulesets" || endpoint === "repos/$repo/rulesets/$ruleset_id") && (method === "POST" || method === "PUT")) {
    return { stdout: '{"id":42,"name":"First Tree Context Repo branch rules"}\\n' };
  }
  return null;
}

function recoveryResponse(argv) {
  const endpoint = endpointArg(argv);
  if (argv[0] === "repo" && argv[1] === "view") {
    const jq = argAfter(argv, "--jq");
    if (jq === ".nameWithOwner") return { exitCode: 0, stdout: "agent-team-foundation/context-tree\\n" };
    if (jq === ".defaultBranchRef.name") return { exitCode: 0, stdout: "main\\n" };
  }
  if (argv[0] === "api" && endpoint === "user") return { exitCode: 0, stdout: "seed-author\\n" };
  if (argv[0] === "api" && (endpoint === "repos/$repo" || endpoint === "repos/agent-team-foundation/context-tree")) {
    return { exitCode: 0, stdout: "Organization\\n" };
  }
  if (argv[0] === "api" && endpoint === "repos/$repo/teams?per_page=100") {
    return { exitCode: 1, stderr: "No qualifying visible non-author team in eval fixture.\\n" };
  }
  if (argv[0] === "api" && endpoint === "repos/$repo/collaborators?affiliation=direct&permission=push&per_page=100") {
    return { exitCode: 1, stderr: "No qualifying non-author collaborator in eval fixture.\\n" };
  }
  return null;
}

const argv = process.argv.slice(2);
const phase = process.env.FIRST_TREE_EVAL_PHASE || "model";
append({ type: "gh_call", phase, argv, cwd: process.cwd() });
trace("gh call: " + commandLine(argv));

const simulated = isGovernanceBootstrapCase() ? bootstrapResponse(argv) : isGovernanceRecoveryCase() ? recoveryResponse(argv) : null;
if (simulated !== null) {
  finish(argv, phase, simulated.exitCode ?? 0, simulated.stdout || "", simulated.stderr || "", { shimmedByEval: true });
}

const stderr = "Blocked gh command in skill eval. No real GitHub side effect was attempted.\\n";
finish(argv, phase, 1, "", stderr, { blockedByEval: true });
`;

  writeText(shimPath, script);
  chmodSync(shimPath, 0o755);
  writeShellPathBootstrap(paths);
}
