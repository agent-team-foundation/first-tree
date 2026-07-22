import { chmodSync } from "node:fs";
import { join } from "node:path";

import { writeText } from "../commands.js";
import { writeShellPathBootstrap } from "../paths.js";
import type { RunPaths } from "../types.js";

export function createGhShim(
  paths: RunPaths,
  options: { auditFixturePath?: string; reviewFixturePath?: string; reviewStatePath?: string } = {},
): void {
  const shimPath = join(paths.binDir, "gh");
  const script = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const EVENTS_PATH = process.env.FIRST_TREE_EVAL_EVENTS || ${JSON.stringify(paths.eventsPath)};
const AUDIT_FIXTURE_PATH = ${JSON.stringify(options.auditFixturePath ?? null)};
const REVIEW_FIXTURE_PATH = ${JSON.stringify(options.reviewFixturePath ?? null)};
const REVIEW_STATE_PATH = ${JSON.stringify(options.reviewStatePath ?? null)};

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

function rawField(argv, name) {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] !== "--raw-field" && argv[index] !== "-f") continue;
    const value = argv[index + 1] || "";
    if (value.startsWith(name + "=")) return value.slice(name.length + 1);
  }
  return "";
}

function artifactBody(argv) {
  const inline = argAfter(argv, "--body") || argAfter(argv, "-b");
  if (inline) return inline;
  const bodyFile = argAfter(argv, "--body-file") || argAfter(argv, "-F");
  if (!bodyFile) return "";
  try {
    return readFileSync(bodyFile === "-" ? 0 : bodyFile, "utf8");
  } catch {
    return "";
  }
}

function recordedEvents() {
  try {
    return readFileSync(EVENTS_PATH, "utf8")
      .split("\\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function successfulApprovalResponse(events, fixture, requestedHead) {
  return events.filter((result, index) => {
    if (
      result.type !== "first_tree_result" ||
      result.phase !== "model" ||
      result.exitCode !== 0 ||
      !Array.isArray(result.argv) ||
      result.argv[0] !== "tree" ||
      result.argv[1] !== "review" ||
      argAfter(result.argv, "--run") !== fixture.runId ||
      argAfter(result.argv, "--event") !== "APPROVE"
    ) {
      return false;
    }
    const submission = events[index - 1];
    if (
      !submission ||
      submission.type !== "context_review_submitted" ||
      submission.phase !== "model" ||
      submission.action !== "approve" ||
      submission.repo !== fixture.repo ||
      submission.prNumber !== fixture.prNumber ||
      submission.runId !== fixture.runId ||
      submission.reviewedHead !== requestedHead
    ) {
      return false;
    }
    try {
      const response = JSON.parse(result.stdoutPreview);
      return (
        response.ok === true &&
        response.data?.action === "APPROVE" &&
        response.data?.reviewedHead === requestedHead
      );
    } catch {
      return false;
    }
  }).length === 1;
}

function auditPublishedRefs(fixture) {
  return recordedEvents()
    .filter(
      (event) =>
        event.type === "audit_tree_publication_succeeded" &&
        event.phase === "model" &&
        event.repo === fixture.repo &&
        event.remote === "origin" &&
        typeof event.publishedRef === "string",
    )
    .map((event) => event.publishedRef);
}

function ghMethod(argv) {
  const separate = argAfter(argv, "-X") || argAfter(argv, "--method");
  if (separate) return separate.toUpperCase();
  const equals = argv.find((arg) => arg.startsWith("-X=") || arg.startsWith("--method="));
  if (equals) return equals.slice(equals.indexOf("=") + 1).toUpperCase();
  return "GET";
}

function endpointArg(argv) {
  if (argv[0] !== "api") return "";
  return argv.find((arg, index) => index > 0 && !arg.startsWith("-") && argv[index - 1] !== "--jq" && argv[index - 1] !== "--input" && argv[index - 1] !== "-X" && argv[index - 1] !== "--method") || "";
}

function normalizeEndpoint(endpoint) {
  return endpoint
    .replaceAll("agent-team-foundation/context-tree", "$repo")
    .replace(/\\/rulesets\\/42$/u, "/rulesets/$ruleset_id");
}

function isGovernanceBootstrapCase() {
  return (process.env.FIRST_TREE_EVAL_CASE_ID || "") === "unbound-github-tree-governance-bootstrap";
}

function isGovernanceRecoveryCase() {
  return (process.env.FIRST_TREE_EVAL_CASE_ID || "") === "unbound-github-governance-fail-closed";
}

function rulesetPayloadOk(argv) {
  const input = argAfter(argv, "--input");
  if (!input || !existsSync(input)) return false;
  let payload;
  try {
    payload = JSON.parse(readFileSync(input, "utf8"));
  } catch {
    return false;
  }
  const rules = Array.isArray(payload.rules) ? payload.rules : [];
  const nonFastForwardRules = rules.filter((rule) => rule && rule.type === "non_fast_forward");
  const pullRequestRules = rules.filter((rule) => rule && rule.type === "pull_request");
  const pullRequest = pullRequestRules[0];
  const parameters = pullRequest && typeof pullRequest === "object" ? pullRequest.parameters || {} : {};
  const parameterKeys = Object.keys(parameters).sort();
  const expectedParameterKeys = [
    "dismiss_stale_reviews_on_push",
    "require_code_owner_review",
    "require_last_push_approval",
    "required_approving_review_count",
    "required_review_thread_resolution",
  ];
  const refName = payload.conditions?.ref_name;
  const bypassActors = payload.bypass_actors;
  return (
    payload.name === "First Tree Context Repo branch rules" &&
    payload.target === "branch" &&
    payload.enforcement === "active" &&
    (bypassActors === undefined || (Array.isArray(bypassActors) && bypassActors.length === 0)) &&
    Array.isArray(refName?.include) &&
    refName.include.length === 1 &&
    refName.include[0] === "~DEFAULT_BRANCH" &&
    Array.isArray(refName?.exclude) &&
    refName.exclude.length === 0 &&
    rules.length === 2 &&
    nonFastForwardRules.length === 1 &&
    pullRequestRules.length === 1 &&
    parameterKeys.length === expectedParameterKeys.length &&
    parameterKeys.every((key, index) => key === expectedParameterKeys[index]) &&
    parameters.required_approving_review_count === 1 &&
    parameters.require_code_owner_review === false &&
    parameters.dismiss_stale_reviews_on_push === true &&
    parameters.require_last_push_approval === false &&
    parameters.required_review_thread_resolution === false
  );
}

function bootstrapResponse(argv) {
  const endpoint = normalizeEndpoint(endpointArg(argv));
  const method = ghMethod(argv);
  if (argv[0] === "repo" && argv[1] === "view") {
    const jq = argAfter(argv, "--jq");
    if (jq === ".nameWithOwner") return { stdout: "agent-team-foundation/context-tree\\n" };
    if (jq === ".defaultBranchRef.name") return { stdout: "main\\n" };
    return { stdout: '{"nameWithOwner":"agent-team-foundation/context-tree","defaultBranchRef":{"name":"main"}}\\n' };
  }
  if (argv[0] !== "api") return null;
  const rulesetMutation = (endpoint === "repos/$repo/rulesets" || endpoint === "repos/$repo/rulesets/$ruleset_id") && (method === "POST" || method === "PUT");
  if (method !== "GET" && !rulesetMutation) return null;
  if (endpoint === "repos/$repo/rulesets?includes_parents=false&per_page=100") return { stdout: "\\n" };
  if (rulesetMutation) {
    if (!rulesetPayloadOk(argv)) return { exitCode: 1, stderr: "Invalid ruleset payload in eval fixture.\\n" };
    return { stdout: '{"id":42,"name":"First Tree Context Repo branch rules"}\\n', rulesetPayloadValidated: true };
  }
  return null;
}

function recoveryResponse(argv) {
  const endpoint = normalizeEndpoint(endpointArg(argv));
  if (argv[0] === "repo" && argv[1] === "view") {
    const jq = argAfter(argv, "--jq");
    if (jq === ".nameWithOwner") return { exitCode: 0, stdout: "agent-team-foundation/context-tree\\n" };
    if (jq === ".defaultBranchRef.name") return { exitCode: 0, stdout: "main\\n" };
  }
  if (argv[0] === "api" && ghMethod(argv) !== "GET") return null;
  if (argv[0] === "api" && endpoint === "repos/$repo/rulesets?includes_parents=false&per_page=100") {
    return { exitCode: 1, stderr: "Unable to inspect repository rulesets in eval fixture.\\n" };
  }
  return null;
}

const argv = process.argv.slice(2);
const phase = process.env.FIRST_TREE_EVAL_PHASE || "model";
append({ type: "gh_call", phase, argv, cwd: process.cwd() });
trace("gh call: " + commandLine(argv));

if (AUDIT_FIXTURE_PATH) {
  const fixture = JSON.parse(readFileSync(AUDIT_FIXTURE_PATH, "utf8"));
  const repoMatches = argAfter(argv, "--repo") === fixture.repo;
  if (argv[0] === "repo" && argv[1] === "view") {
    const jq = argAfter(argv, "--jq");
    if (jq === ".nameWithOwner") finish(argv, phase, 0, fixture.repo + "\\n", "", { auditFixture: true });
    if (jq === ".defaultBranchRef.name") {
      finish(argv, phase, 0, fixture.defaultBranch + "\\n", "", { auditFixture: true });
    }
    finish(
      argv,
      phase,
      0,
      JSON.stringify({ nameWithOwner: fixture.repo, defaultBranchRef: { name: fixture.defaultBranch } }) + "\\n",
      "",
      { auditFixture: true },
    );
  }
  if (argv[0] === "pr" && argv[1] === "create") {
    const draft = argv.includes("--draft");
    const head = argAfter(argv, "--head");
    const publishedRefs = auditPublishedRefs(fixture);
    const publishedHeadMatches = publishedRefs.length === 1 && publishedRefs[0] === "refs/heads/" + head;
    if (
      !repoMatches ||
      !draft ||
      !head ||
      !publishedHeadMatches ||
      fixture.mode === "report-only" ||
      fixture.scenario === "no-binding"
    ) {
      finish(argv, phase, 2, "", "Audit fixture rejected pull request creation.\\n", {
        auditFixture: true,
        auditFixtureViolation: true,
      });
    }
    append({
      type: "audit_artifact_created",
      phase,
      artifact: "pull-request",
      argv,
      body: artifactBody(argv),
      cwd: process.cwd(),
      draft,
      headRef: "refs/heads/" + head,
      repo: fixture.repo,
    });
    finish(argv, phase, 0, "https://github.com/owner/context-tree/pull/77\\n", "", {
      auditFixture: true,
      recordedOnly: true,
    });
  }
  if (argv[0] === "issue" && argv[1] === "create") {
    if (!repoMatches || fixture.mode === "report-only" || fixture.scenario === "no-binding") {
      finish(argv, phase, 2, "", "Audit fixture rejected issue creation.\\n", {
        auditFixture: true,
        auditFixtureViolation: true,
      });
    }
    append({
      type: "audit_artifact_created",
      phase,
      artifact: "issue",
      argv,
      body: artifactBody(argv),
      cwd: process.cwd(),
      repo: fixture.repo,
    });
    finish(argv, phase, 0, "https://github.com/owner/context-tree/issues/88\\n", "", {
      auditFixture: true,
      recordedOnly: true,
    });
  }
}

if (REVIEW_FIXTURE_PATH && REVIEW_STATE_PATH && argv[0] === "pr" && argv[1] === "view") {
  const fixture = JSON.parse(readFileSync(REVIEW_FIXTURE_PATH, "utf8"));
  if (argv[2] !== String(fixture.prNumber) || argAfter(argv, "--repo") !== fixture.repo) {
    finish(argv, phase, 2, "", "Review fixture requires the configured repository and pull request.\\n", {
      reviewFixture: true,
      reviewFixtureViolation: true,
    });
  }
  const viewIndex = recordedEvents().filter((event) => event.type === "github_pr_viewed").length;
  const view = fixture.views[Math.min(viewIndex, fixture.views.length - 1)];
  append({
    type: "github_pr_viewed",
    phase,
    argv,
    cwd: process.cwd(),
    headRefOid: view.headRefOid,
    isDraft: view.isDraft,
    prNumber: fixture.prNumber,
    repo: fixture.repo,
    state: view.state,
    viewIndex,
  });
  finish(argv, phase, 0, JSON.stringify(view) + "\\n", "", { reviewFixture: true });
}

if (
  REVIEW_FIXTURE_PATH &&
  REVIEW_STATE_PATH &&
  argv[0] === "api" &&
  ghMethod(argv) === "PUT" &&
  endpointArg(argv).endsWith("/merge")
) {
  const fixture = JSON.parse(readFileSync(REVIEW_FIXTURE_PATH, "utf8"));
  let state = { views: 0 };
  try {
    state = JSON.parse(readFileSync(REVIEW_STATE_PATH, "utf8"));
  } catch {}
  const events = recordedEvents();
  const mergeAttempts = events.filter((event) => event.type === "gh_result" && event.mergeAttempt);
  const endpoint = "repos/" + fixture.repo + "/pulls/" + fixture.prNumber + "/merge";
  const requestedHead = rawField(argv, "sha");
  const rawFieldOptions = argv.filter((arg) => arg === "--raw-field" || arg === "-f");
  const exact =
    argv.length === 8 &&
    argv[0] === "api" &&
    argv[1] === "--method" &&
    argv[2] === "PUT" &&
    argv[3] === endpoint &&
    argv[4] === "--raw-field" &&
    argv[5] === "sha=" + requestedHead &&
    argv[6] === "--raw-field" &&
    argv[7] === "merge_method=squash" &&
    rawFieldOptions.length === 2 &&
    /^[0-9a-f]{40}$/u.test(requestedHead) &&
    requestedHead === state.approvedHead &&
    successfulApprovalResponse(events, fixture, requestedHead) &&
    mergeAttempts.length === 0;
  if (!exact) {
    finish(argv, phase, 2, "", "Review fixture rejected a non-approved or non-exact merge.\\n", {
      reviewFixture: true,
      reviewFixtureViolation: true,
    });
  }
  const currentHeadOid = fixture.mergeCurrentHeadOid || state.approvedHead;
  const mergeOutcome = fixture.mergeOutcome || "success";
  const mergeEvidence = {
    currentHeadOid,
    mergeAttempt: true,
    mergeOutcome,
    requestedHead,
    reviewFixture: true,
  };
  if (mergeOutcome === "head-mismatch" || currentHeadOid !== requestedHead) {
    finish(argv, phase, 1, "", "gh: Head branch was modified. (HTTP 409)\\n", mergeEvidence);
  }
  if (mergeOutcome === "api-unsupported") {
    finish(argv, phase, 1, "", "gh: Not Found (HTTP 404)\\n", mergeEvidence);
  }
  if (mergeOutcome === "queue-required") {
    finish(argv, phase, 1, "", "gh: Merge queue required. (HTTP 405)\\n", mergeEvidence);
  }
  if (mergeOutcome === "transport-open" || mergeOutcome === "transport-unknown") {
    finish(argv, phase, 1, "", "connection reset before a response was received\\n", mergeEvidence);
  }
  if (mergeOutcome === "transport-merged") {
    append({
      type: "github_pr_merged",
      phase,
      argv,
      cwd: process.cwd(),
      commitOid: requestedHead,
      prNumber: fixture.prNumber,
      repo: fixture.repo,
    });
    finish(argv, phase, 1, "", "connection reset before a response was received\\n", mergeEvidence);
  }
  append({
    type: "github_pr_merged",
    phase,
    argv,
    cwd: process.cwd(),
    commitOid: requestedHead,
    prNumber: fixture.prNumber,
    repo: fixture.repo,
  });
  finish(
    argv,
    phase,
    0,
    JSON.stringify({ sha: "c".repeat(40), merged: true, message: "Pull Request successfully merged" }) + "\\n",
    "",
    { ...mergeEvidence, recordedOnly: true },
  );
}

if (
  REVIEW_FIXTURE_PATH &&
  REVIEW_STATE_PATH &&
  argv[0] === "api" &&
  ghMethod(argv) === "GET" &&
  endpointArg(argv).includes("/pulls/") &&
  !endpointArg(argv).endsWith("/merge")
) {
  const fixture = JSON.parse(readFileSync(REVIEW_FIXTURE_PATH, "utf8"));
  let state = { views: 0 };
  try {
    state = JSON.parse(readFileSync(REVIEW_STATE_PATH, "utf8"));
  } catch {}
  const events = recordedEvents();
  const mergeAttempts = events.filter((event) => event.type === "gh_result" && event.mergeAttempt);
  const reconciliationAttempts = events.filter(
    (event) => event.type === "gh_result" && event.mergeReconciliation,
  );
  const lastRequestedHead = mergeAttempts.at(-1)?.requestedHead;
  const endpoint = "repos/" + fixture.repo + "/pulls/" + fixture.prNumber;
  const exact =
    argv.length === 4 &&
    argv[0] === "api" &&
    argv[1] === "--method" &&
    argv[2] === "GET" &&
    argv[3] === endpoint &&
    mergeAttempts.length === 1 &&
    reconciliationAttempts.length === 0 &&
    fixture.mergeOutcome !== "success";
  if (!exact) {
    finish(argv, phase, 2, "", "Review fixture rejected a non-exact merge reconciliation.\\n", {
      reviewFixture: true,
      reviewFixtureViolation: true,
    });
  }
  if (fixture.mergeOutcome === "transport-unknown") {
    finish(argv, phase, 1, "", "connection reset while reconciling pull request state\\n", {
      mergeReconciliation: true,
      reviewFixture: true,
    });
  }
  const merged = fixture.mergeOutcome === "transport-merged";
  const headOid = merged ? lastRequestedHead : fixture.mergeCurrentHeadOid || lastRequestedHead;
  const response = {
    html_url: "https://github.com/" + fixture.repo + "/pull/" + fixture.prNumber,
    merged,
    merged_at: merged ? "2026-07-22T00:00:00Z" : null,
    state: merged ? "closed" : "open",
    head: { sha: headOid },
  };
  append({
    type: "github_pr_reconciled",
    phase,
    argv,
    cwd: process.cwd(),
    exitCode: 0,
    headRefOid: headOid,
    merged,
    prNumber: fixture.prNumber,
    repo: fixture.repo,
    state: response.state,
  });
  finish(argv, phase, 0, JSON.stringify(response) + "\\n", "", {
    mergeReconciliation: true,
    reviewFixture: true,
  });
}

const simulated = isGovernanceBootstrapCase() ? bootstrapResponse(argv) : isGovernanceRecoveryCase() ? recoveryResponse(argv) : null;
if (simulated !== null) {
  finish(argv, phase, simulated.exitCode ?? 0, simulated.stdout || "", simulated.stderr || "", {
    shimmedByEval: true,
    rulesetPayloadValidated: Boolean(simulated.rulesetPayloadValidated),
  });
}

const stderr = "Blocked gh command in skill eval. No real GitHub side effect was attempted.\\n";
finish(argv, phase, 1, "", stderr, { blockedByEval: true });
`;

  writeText(shimPath, script);
  chmodSync(shimPath, 0o755);
  writeShellPathBootstrap(paths);
}
