import { chmodSync } from "node:fs";
import { join } from "node:path";

import { writeText } from "../commands.js";
import { writeShellPathBootstrap } from "../paths.js";
import type { RunPaths } from "../types.js";

export function createGhShim(paths: RunPaths, options: { reviewFixturePath?: string } = {}): void {
  const shimPath = join(paths.binDir, "gh");
  const script = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const EVENTS_PATH = process.env.FIRST_TREE_EVAL_EVENTS || ${JSON.stringify(paths.eventsPath)};
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

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || null : null;
}

function trace(message) {
  if (process.env.FIRST_TREE_EVAL_VERBOSE === "1") {
    const caseId = process.env.FIRST_TREE_EVAL_CASE_ID || "unknown";
    process.stderr.write("[" + caseId + "] " + message + "\\n");
  }
}

const argv = process.argv.slice(2);
const phase = process.env.FIRST_TREE_EVAL_PHASE || "model";
append({ type: "gh_call", phase, argv, cwd: process.cwd() });

function finish(exitCode, stdout, stderr, extra = {}) {
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
  process.exit(exitCode);
}

if (REVIEW_FIXTURE_PATH) {
  const fixture = JSON.parse(readFileSync(REVIEW_FIXTURE_PATH, "utf8"));
  const statePath = REVIEW_FIXTURE_PATH + ".state";
  let state = { views: 0 };
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {}

  function targetMatches() {
    return argv[2] === String(fixture.prNumber) && optionValue(argv, "--repo") === fixture.repo;
  }

  function apiEndpoint() {
    for (let index = 1; index < argv.length; index += 1) {
      if (["--method", "--input"].includes(argv[index])) {
        index += 1;
        continue;
      }
      if (!argv[index].startsWith("-")) return argv[index];
    }
    return null;
  }

  function reviewEndpointMatches() {
    return apiEndpoint() === "repos/" + fixture.repo + "/pulls/" + fixture.prNumber + "/reviews";
  }

  function rejectFixtureCall(message) {
    finish(2, "", message + "\\n", { reviewFixture: true, reviewFixtureViolation: true });
  }

  if (argv[0] === "api" && argv[1] === "user") {
    if (argv.length !== 4 || argv[2] !== "--jq" || argv[3] !== ".login") {
      rejectFixtureCall("Review fixture requires exact 'gh api user --jq .login'.");
    }
    const stdout = argv.includes("--jq") ? fixture.reviewerLogin + "\\n" : JSON.stringify({ login: fixture.reviewerLogin }) + "\\n";
    append({ type: "github_identity_read", phase, login: fixture.reviewerLogin, argv, cwd: process.cwd() });
    finish(0, stdout, "", { reviewFixture: true });
  }

  if (argv[0] === "pr" && argv[1] === "view") {
    if (!targetMatches()) rejectFixtureCall("Review fixture requires the configured repository and pull request.");
    const views = fixture.views;
    const view = views[Math.min(state.views, views.length - 1)];
    const viewIndex = state.views;
    state.views += 1;
    writeFileSync(statePath, JSON.stringify(state), "utf8");
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
    finish(0, JSON.stringify(view) + "\\n", "", { reviewFixture: true });
  }

  if (argv[0] === "api" && reviewEndpointMatches()) {
    const method = optionValue(argv, "--method");
    const inputPath = optionValue(argv, "--input");
    if (method !== "POST" || !inputPath) {
      rejectFixtureCall("Review fixture requires the commit-bound create-review API with POST and --input.");
    }
    let payload;
    try {
      payload = JSON.parse(readFileSync(inputPath, "utf8"));
    } catch {
      rejectFixtureCall("Review fixture requires a readable JSON review payload.");
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof payload.body !== "string" ||
      typeof payload.commit_id !== "string" ||
      !["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(payload.event)
    ) {
      rejectFixtureCall("Review fixture requires body, commit_id, and one supported review event.");
    }
    if (payload.commit_id !== fixture.reviewHeadOid) {
      rejectFixtureCall("Review fixture requires the inspected review-head commit_id.");
    }
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.reviewWorktreePath,
      encoding: "utf8",
    });
    const symbolicHead = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], {
      cwd: fixture.reviewWorktreePath,
      encoding: "utf8",
    });
    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: fixture.reviewWorktreePath,
      encoding: "utf8",
    });
    if (
      head.status !== 0 ||
      head.stdout.trim() !== fixture.reviewHeadOid ||
      symbolicHead.status === 0 ||
      status.status !== 0 ||
      status.stdout.trim() !== ""
    ) {
      rejectFixtureCall("Review fixture requires the registered clean detached PR-head worktree at submission time.");
    }
    const action = {
      APPROVE: "approve",
      COMMENT: "comment",
      REQUEST_CHANGES: "request-changes",
    }[payload.event];
    append({
      type: "github_review_submitted",
      phase,
      action,
      body: payload.body,
      bodyFileUsed: true,
      commitOid: payload.commit_id,
      currentHeadOid: fixture.submissionHeadOid,
      prNumber: fixture.prNumber,
      repo: fixture.repo,
      argv,
      cwd: process.cwd(),
    });
    finish(
      0,
      JSON.stringify({ body: payload.body, commit_id: payload.commit_id, state: payload.event }) + "\\n",
      "",
      { reviewFixture: true },
    );
  }
}

trace("gh call blocked: " + commandLine(argv));

const stderr = "Blocked gh command in skill eval. No real GitHub side effect was attempted.\\n";
process.stderr.write(stderr);
finish(1, "", stderr, { blockedByEval: true });
`;

  writeText(shimPath, script);
  chmodSync(shimPath, 0o755);
  writeShellPathBootstrap(paths);
}
