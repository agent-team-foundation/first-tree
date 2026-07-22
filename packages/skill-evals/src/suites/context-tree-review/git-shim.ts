import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";

import { writeText } from "../../core/commands.js";
import type { RunPaths } from "../../core/types.js";

export function createContextTreeReviewGitShim(paths: RunPaths, options: { reviewFixturePath: string }): void {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const shimPath = join(paths.binDir, "git");
  const script = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const REAL_GIT = ${JSON.stringify(realGit)};
const EVENTS_PATH = process.env.FIRST_TREE_EVAL_EVENTS || ${JSON.stringify(paths.eventsPath)};
const REVIEW_FIXTURE_PATH = ${JSON.stringify(options.reviewFixturePath)};

function append(event) {
  appendFileSync(EVENTS_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + "\\n", "utf8");
}

function commandContext(argv) {
  if (argv[0] === "-C" && argv[1]) {
    return { command: argv.slice(2), repoPath: resolve(process.cwd(), argv[1]) };
  }
  return { command: argv, repoPath: resolve(process.cwd()) };
}

const argv = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(REVIEW_FIXTURE_PATH, "utf8"));
const context = commandContext(argv);
const result = spawnSync(REAL_GIT, argv, {
  cwd: process.cwd(),
  encoding: "utf8",
  env: process.env,
  maxBuffer: 20 * 1024 * 1024,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.status === 0 && context.command[0] === "diff") {
  const args = context.command.slice(1).filter((arg) => arg !== "--no-ext-diff");
  const expectedRanges = [fixture.view.baseRefOid + "..HEAD", fixture.view.baseRefOid + "...HEAD"];
  let repoPath = null;
  let reviewPath = null;
  try {
    repoPath = realpathSync(context.repoPath);
    reviewPath = realpathSync(fixture.reviewWorktreePath);
  } catch {}
  if (repoPath !== null && repoPath === reviewPath && args.length === 1 && expectedRanges.includes(args[0])) {
    const head = spawnSync(REAL_GIT, ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" });
    const live = spawnSync(REAL_GIT, ["--git-dir", fixture.originPath, "rev-parse", fixture.pullRef], {
      encoding: "utf8",
    });
    if (head.status === 0 && live.status === 0 && head.stdout.trim() === live.stdout.trim()) {
      append({
        type: "context_review_successor_diff_viewed",
        phase: process.env.FIRST_TREE_EVAL_PHASE || "model",
        baseOid: fixture.view.baseRefOid,
        headOid: head.stdout.trim(),
        prNumber: fixture.prNumber,
        repo: fixture.repo,
      });
    }
  }
}

process.exit(result.status ?? 1);
`;
  writeText(shimPath, script);
  chmodSync(shimPath, 0o755);
}
