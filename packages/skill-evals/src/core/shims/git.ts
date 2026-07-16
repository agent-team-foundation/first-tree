import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";

import { writeText } from "../commands.js";
import { writeShellPathBootstrap } from "../paths.js";
import type { RunPaths } from "../types.js";

export function createGitShim(paths: RunPaths, options: { auditFixturePath: string }): void {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const shimPath = join(paths.binDir, "git");
  const script = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REAL_GIT = ${JSON.stringify(realGit)};
const EVENTS_PATH = process.env.FIRST_TREE_EVAL_EVENTS || ${JSON.stringify(paths.eventsPath)};
const AUDIT_FIXTURE_PATH = ${JSON.stringify(options.auditFixturePath)};
const FETCH_STATE_PATH = AUDIT_FIXTURE_PATH + ".fetch-state";

function append(event) {
  appendFileSync(EVENTS_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + "\\n", "utf8");
}

function commandContext(argv) {
  if (argv[0] === "-C" && argv[1]) {
    return { command: argv.slice(2), repoPath: resolve(process.cwd(), argv[1]) };
  }
  return { command: argv, repoPath: resolve(process.cwd()) };
}

function isAuditSnapshotAdd(command, fixture, repoPath) {
  if (command[0] !== "worktree" || command[1] !== "add" || !fixture.auditWorktreePath) return false;
  const targetsSnapshot = command.some(
    (arg) => resolve(process.cwd(), arg) === fixture.auditWorktreePath || resolve(repoPath, arg) === fixture.auditWorktreePath,
  );
  return command.includes("--detach") && targetsSnapshot && !command.includes("-b") && !command.includes("-B");
}

function isAuthoringCommand(command, fixture, repoPath) {
  if (command[0] === "worktree" && command[1] === "add") return !isAuditSnapshotAdd(command, fixture, repoPath);
  if (command[0] === "branch" && (command.includes("-d") || command.includes("-D") || command.includes("--delete"))) {
    return false;
  }
  return ["add", "branch", "checkout", "commit", "merge", "mv", "rebase", "reset", "rm", "switch", "update-ref"].includes(command[0] || "");
}

function isPublicationCommand(command) {
  return command[0] === "push";
}

function gitCommonDir(repoPath) {
  const result = spawnSync(REAL_GIT, ["-C", repoPath, "rev-parse", "--git-common-dir"], { encoding: "utf8" });
  return result.status === 0 ? resolve(repoPath, result.stdout.trim()) : null;
}

function publicationTarget(command, repoPath) {
  if (!isPublicationCommand(command)) return null;
  const positional = command.slice(1).filter((arg) => !arg.startsWith("-"));
  const remote = positional[0] || null;
  const refspec = positional[1] || null;
  if (remote !== "origin" || !refspec) return null;
  let destination = refspec.includes(":") ? refspec.slice(refspec.indexOf(":") + 1) : refspec;
  if (destination === "HEAD") {
    const branch = spawnSync(REAL_GIT, ["-C", repoPath, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" });
    if (branch.status !== 0) return null;
    destination = branch.stdout.trim();
  }
  return {
    publishedRef: destination.startsWith("refs/heads/") ? destination : "refs/heads/" + destination,
    remote,
  };
}

const argv = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(AUDIT_FIXTURE_PATH, "utf8"));
const context = commandContext(argv);
const mainTreePath = resolve(fixture.workspacePath, "context-tree");
const exactFetch =
  context.repoPath === mainTreePath &&
  context.command.length === 2 &&
  context.command[0] === "fetch" &&
  context.command[1] === "origin";
const exactHeadRead =
  context.repoPath === mainTreePath &&
  context.command.length === 2 &&
  context.command[0] === "rev-parse" &&
  context.command[1] === "refs/remotes/origin/" + fixture.defaultBranch;

const authoringCommand = isAuthoringCommand(context.command, fixture, context.repoPath);
const publicationCommand = isPublicationCommand(context.command);

const result = spawnSync(REAL_GIT, argv, {
  cwd: process.cwd(),
  encoding: "utf8",
  env: process.env,
  maxBuffer: 20 * 1024 * 1024,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (authoringCommand && result.status === 0) {
  append({
    type: "audit_tree_authoring_started",
    phase: process.env.FIRST_TREE_EVAL_PHASE || "model",
    argv,
    command: context.command,
    cwd: process.cwd(),
    repoPath: context.repoPath,
  });
}

const publication = publicationTarget(context.command, context.repoPath);
if (
  publicationCommand &&
  result.status === 0 &&
  publication &&
  gitCommonDir(context.repoPath) === resolve(mainTreePath, ".git")
) {
  append({
    type: "audit_tree_publication_succeeded",
    phase: process.env.FIRST_TREE_EVAL_PHASE || "model",
    argv,
    command: context.command,
    cwd: process.cwd(),
    publishedRef: publication.publishedRef,
    remote: publication.remote,
    repo: fixture.repo,
    repoPath: context.repoPath,
  });
}

if (exactFetch && result.status === 0) {
  writeFileSync(FETCH_STATE_PATH, JSON.stringify({ fetchedAt: new Date().toISOString() }), "utf8");
  append({
    type: "audit_write_freshness_fetch",
    phase: process.env.FIRST_TREE_EVAL_PHASE || "model",
    branch: fixture.defaultBranch,
    repo: fixture.repo,
    repoPath: context.repoPath,
  });
}
if (exactHeadRead && result.status === 0) {
  append({
    type: "audit_write_freshness_observed",
    phase: process.env.FIRST_TREE_EVAL_PHASE || "model",
    auditedHead: fixture.headOid,
    branch: fixture.defaultBranch,
    fetchObserved: existsSync(FETCH_STATE_PATH),
    observedRemoteHead: result.stdout.trim(),
    repo: fixture.repo,
    repoPath: context.repoPath,
  });
}

process.exit(result.status ?? 1);
`;
  writeText(shimPath, script);
  chmodSync(shimPath, 0o755);
  writeShellPathBootstrap(paths);
}
