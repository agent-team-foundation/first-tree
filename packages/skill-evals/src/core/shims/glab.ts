import { chmodSync } from "node:fs";
import { join } from "node:path";

import { writeText } from "../commands.js";
import type { RunPaths } from "../types.js";

export function createGlabShim(paths: RunPaths, options: { reviewFixturePath: string }): void {
  const shimPath = join(paths.binDir, "glab");
  const script = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const EVENTS_PATH = process.env.FIRST_TREE_EVAL_EVENTS || ${JSON.stringify(paths.eventsPath)};
const REVIEW_FIXTURE_PATH = ${JSON.stringify(options.reviewFixturePath)};

function append(event) {
  appendFileSync(EVENTS_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + "\\n", "utf8");
}

function argAfter(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || "" : "";
}

function finish(argv, exitCode, stdout, stderr, extra = {}) {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  append({
    type: "glab_result",
    phase: process.env.FIRST_TREE_EVAL_PHASE || "model",
    argv,
    cwd: process.cwd(),
    exitCode,
    ...extra,
  });
  process.exit(exitCode);
}

function liveHead(fixture) {
  const result = spawnSync("git", ["--git-dir", fixture.originPath, "rev-parse", fixture.pullRef], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim().toLowerCase() : "";
}

function changedPaths(fixture, head) {
  const result = spawnSync(
    "git",
    ["--git-dir", fixture.originPath, "diff", "--name-only", fixture.view.baseRefOid, head],
    { encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.split("\\n").filter(Boolean) : [];
}

function bodyFrom(argv) {
  const inline = argAfter(argv, "--message") || argAfter(argv, "-m");
  if (inline) return inline;
  const bodyFile = argAfter(argv, "--message-file") || argAfter(argv, "-F");
  if (!bodyFile) return "";
  try {
    return readFileSync(bodyFile === "-" ? 0 : bodyFile, "utf8");
  } catch {
    return "";
  }
}

const argv = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(REVIEW_FIXTURE_PATH, "utf8"));
const phase = process.env.FIRST_TREE_EVAL_PHASE || "model";
const repo = argAfter(argv, "--repo");
const exactHost = new URL(fixture.instanceOrigin).host;
const statePath = REVIEW_FIXTURE_PATH + ".state";
append({ type: "glab_call", phase, argv, cwd: process.cwd() });

if (argv[0] === "auth" && argv[1] === "status") {
  const host = argAfter(argv, "--hostname");
  if (host !== exactHost) {
    finish(argv, 2, "", "GitLab eval fixture requires the exact configured host.\\n", { blockedByEval: true });
  }
  finish(argv, 0, exactHost + ": authenticated as repair-first-reviewer\\n", "");
}

if (argv[0] === "api" && argv[1] === "user") {
  const host = argAfter(argv, "--hostname");
  if (host && host !== exactHost) {
    finish(argv, 2, "", "GitLab eval fixture requires the exact configured host.\\n", { blockedByEval: true });
  }
  append({ type: "gitlab_identity_read", phase, login: "repair-first-reviewer" });
  finish(argv, 0, JSON.stringify({ username: "repair-first-reviewer" }) + "\\n", "");
}

if (argv[0] === "mr" && argv[1] === "view") {
  const iid = Number(argv[2]);
  if (iid !== fixture.prNumber || repo !== fixture.repo) {
    finish(argv, 2, "", "GitLab eval fixture rejected an MR identity mismatch.\\n", {
      blockedByEval: true,
      reviewFixtureViolation: true,
    });
  }
  const head = liveHead(fixture);
  const merged = existsSync(statePath) && JSON.parse(readFileSync(statePath, "utf8")).merged === true;
  const response = {
    iid,
    id: 4200,
    project_id: 4242,
    title: fixture.view.title,
    description: fixture.view.body,
    state: merged ? "merged" : "opened",
    draft: fixture.view.isDraft,
    web_url: fixture.view.url,
    target_branch: fixture.view.baseRefName,
    target_branch_sha: fixture.view.baseRefOid,
    source_branch: fixture.view.headRefName,
    source_branch_sha: head,
    sha: head,
    author: { username: "contributor" },
    source_project_id: 4242,
    target_project_id: 4242,
    source_project_path: "owner/context-tree",
    target_project_path: "owner/context-tree",
    pipeline: { status: "success", sha: head },
    changes: changedPaths(fixture, head).map((path) => ({ old_path: path, new_path: path })),
  };
  append({
    type: "gitlab_mr_viewed",
    phase,
    repo: fixture.repo,
    mrIid: iid,
    headRefOid: head,
    isDraft: fixture.view.isDraft,
    state: merged ? "MERGED" : "OPEN",
    fork: false,
    pipelineAcceptable: true,
  });
  finish(argv, 0, JSON.stringify(response) + "\\n", "");
}

if (argv[0] === "mr" && argv[1] === "note") {
  const iid = Number(argv[2]);
  const body = bodyFrom(argv);
  if (iid !== fixture.prNumber || repo !== fixture.repo || body.trim().length === 0) {
    finish(argv, 2, "", "GitLab eval fixture rejected the MR note.\\n", {
      blockedByEval: true,
      reviewFixtureViolation: true,
    });
  }
  append({ type: "gitlab_mr_noted", phase, repo, mrIid: iid, head: liveHead(fixture), body });
  finish(argv, 0, "https://gitlab.example:8443/owner/context-tree/-/merge_requests/42#note_1\\n", "");
}

if (argv[0] === "mr" && argv[1] === "merge") {
  const iid = Number(argv[2]);
  const sha = argAfter(argv, "--sha").toLowerCase();
  const currentHead = liveHead(fixture);
  let state = { mergeAttempts: 0, merged: false };
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {}
  const exact =
    iid === fixture.prNumber &&
    repo === fixture.repo &&
    sha === currentHead &&
    /^[0-9a-f]{40}$/.test(sha) &&
    argv.includes("--squash") &&
    argv.includes("--yes") &&
    argv.includes("--auto-merge=false") &&
    state.mergeAttempts === 0;
  const nextState = { mergeAttempts: state.mergeAttempts + 1, merged: exact, mergedHead: exact ? sha : null };
  writeFileSync(statePath, JSON.stringify(nextState), "utf8");
  append({
    type: "gitlab_merge_attempt",
    phase,
    repo,
    mrIid: iid,
    sha,
    currentHead,
    outcome: exact ? "merged" : "rejected",
    failureClass: sha !== currentHead ? "head_mismatch" : exact ? null : "deterministic_validation",
  });
  if (!exact) {
    finish(argv, 2, "", "GitLab eval fixture rejected a non-CAS or repeated merge.\\n", {
      blockedByEval: true,
      reviewFixtureViolation: true,
    });
  }
  finish(argv, 0, "Merge request !42 was merged\\n", "");
}

finish(argv, 2, "", "Blocked glab command in Context Review eval.\\n", {
  blockedByEval: true,
  reviewFixtureViolation: true,
});
`;
  writeText(shimPath, script);
  chmodSync(shimPath, 0o755);
}
