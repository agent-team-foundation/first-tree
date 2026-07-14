import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeText } from "../commands.js";
import { readEvents } from "../events.js";
import { createRunPaths } from "../paths.js";
import { createGhShim } from "../shims/gh.js";

describe("gh eval shim", () => {
  it("allows only deterministic review reads and one commit-bound API review", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-evals-gh-shim-"));
    try {
      const packageRoot = join(root, "packages", "skill-evals");
      const paths = createRunPaths({ caseId: "gh-review", packageRoot, startedAt: "2026-07-14T00:00:00.000Z" });
      const fixturePath = join(paths.runRoot, "fixture.json");
      const reviewWorktreePath = join(paths.workspacePath, ".review-worktrees", "42");
      mkdirSync(reviewWorktreePath, { recursive: true });
      writeText(join(reviewWorktreePath, "NODE.md"), "review fixture\n");
      for (const args of [
        ["init"],
        ["config", "user.email", "eval@example.invalid"],
        ["config", "user.name", "First Tree Eval"],
        ["add", "."],
        ["commit", "-m", "test: seed review worktree"],
      ]) {
        expect(spawnSync("git", args, { cwd: reviewWorktreePath }).status).toBe(0);
      }
      const reviewHeadOid = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: reviewWorktreePath,
        encoding: "utf8",
      }).stdout.trim();
      expect(spawnSync("git", ["checkout", "--detach", reviewHeadOid], { cwd: reviewWorktreePath }).status).toBe(0);
      writeText(
        fixturePath,
        `${JSON.stringify({ prNumber: 42, repo: "owner/context-tree", reviewHeadOid, reviewerLogin: "reviewer", reviewWorktreePath, submissionHeadOid: reviewHeadOid, views: [{ headRefOid: reviewHeadOid, isDraft: false, state: "OPEN" }] })}\n`,
      );
      createGhShim(paths, { reviewFixturePath: fixturePath });
      const env = { ...process.env, FIRST_TREE_EVAL_EVENTS: paths.eventsPath, FIRST_TREE_EVAL_PHASE: "model" };
      const gh = join(paths.binDir, "gh");

      const view = spawnSync(gh, ["pr", "view", "42", "--repo", "owner/context-tree", "--json", "headRefOid,state"], {
        cwd: paths.workspacePath,
        encoding: "utf8",
        env,
      });
      expect(view.status).toBe(0);
      expect(JSON.parse(view.stdout)).toEqual({ headRefOid: reviewHeadOid, isDraft: false, state: "OPEN" });

      const identity = spawnSync(gh, ["api", "user", "--jq", ".login"], {
        cwd: paths.workspacePath,
        encoding: "utf8",
        env,
      });
      expect(identity.status).toBe(0);

      const bodyPath = join(paths.runRoot, "review.md");
      writeText(bodyPath, "## Approved\n");
      const payloadPath = join(paths.runRoot, "review.json");
      writeText(
        payloadPath,
        `${JSON.stringify({ body: readFileSync(bodyPath, "utf8"), commit_id: reviewHeadOid, event: "APPROVE" })}\n`,
      );
      const review = spawnSync(
        gh,
        ["api", "repos/owner/context-tree/pulls/42/reviews", "--method", "POST", "--input", payloadPath],
        { cwd: paths.workspacePath, encoding: "utf8", env },
      );
      expect(review.status).toBe(0);
      expect(readFileSync(bodyPath, "utf8")).toBe("## Approved\n");

      writeText(
        fixturePath,
        `${JSON.stringify({ prNumber: 42, repo: "owner/context-tree", reviewHeadOid, reviewerLogin: "reviewer", reviewWorktreePath, submissionHeadOid: "new-head", views: [{ headRefOid: reviewHeadOid, isDraft: false, state: "OPEN" }] })}\n`,
      );
      const staleReview = spawnSync(
        gh,
        ["api", "repos/owner/context-tree/pulls/42/reviews", "--method", "POST", "--input", payloadPath],
        { cwd: paths.workspacePath, encoding: "utf8", env },
      );
      expect(staleReview.status).toBe(0);
      expect(JSON.parse(staleReview.stdout)).toMatchObject({ commit_id: reviewHeadOid, state: "APPROVE" });
      writeText(
        fixturePath,
        `${JSON.stringify({ prNumber: 42, repo: "owner/context-tree", reviewHeadOid, reviewerLogin: "reviewer", reviewWorktreePath, submissionHeadOid: reviewHeadOid, views: [{ headRefOid: reviewHeadOid, isDraft: false, state: "OPEN" }] })}\n`,
      );

      writeText(join(reviewWorktreePath, "NODE.md"), "dirty review fixture\n");
      const dirtyReview = spawnSync(
        gh,
        ["api", "repos/owner/context-tree/pulls/42/reviews", "--method", "POST", "--input", payloadPath],
        { cwd: paths.workspacePath, encoding: "utf8", env },
      );
      expect(dirtyReview.status).toBe(2);
      expect(dirtyReview.stderr).toContain("clean detached PR-head worktree");

      const blocked = spawnSync(gh, ["pr", "merge", "42"], { cwd: paths.workspacePath, encoding: "utf8", env });
      expect(blocked.status).toBe(1);
      const ambiguousReview = spawnSync(
        gh,
        ["pr", "review", "42", "--repo", "owner/context-tree", "--approve", "--comment", "--body-file", bodyPath],
        { cwd: paths.workspacePath, encoding: "utf8", env },
      );
      expect(ambiguousReview.status).toBe(1);
      const wrongTarget = spawnSync(
        gh,
        ["api", "repos/owner/context-tree/pulls/43/reviews", "--method", "POST", "--input", payloadPath],
        { cwd: paths.workspacePath, encoding: "utf8", env },
      );
      expect(wrongTarget.status).toBe(1);
      expect(readEvents(paths.eventsPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "approve",
            bodyFileUsed: true,
            commitOid: reviewHeadOid,
            currentHeadOid: reviewHeadOid,
            prNumber: 42,
            repo: "owner/context-tree",
            type: "github_review_submitted",
          }),
          expect.objectContaining({ headRefOid: reviewHeadOid, prNumber: 42, type: "github_pr_viewed" }),
          expect.objectContaining({
            commitOid: reviewHeadOid,
            currentHeadOid: "new-head",
            type: "github_review_submitted",
          }),
          expect.objectContaining({ login: "reviewer", type: "github_identity_read" }),
          expect.objectContaining({ argv: ["pr", "merge", "42"], blockedByEval: true, type: "gh_result" }),
          expect.objectContaining({ reviewFixtureViolation: true, type: "gh_result" }),
        ]),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("keeps every gh command blocked without an explicit review fixture", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-evals-gh-shim-"));
    try {
      const packageRoot = join(root, "packages", "skill-evals");
      const paths = createRunPaths({ caseId: "gh-blocked", packageRoot, startedAt: "2026-07-14T00:00:00.000Z" });
      createGhShim(paths);
      const result = spawnSync(join(paths.binDir, "gh"), ["pr", "view", "42"], {
        cwd: paths.workspacePath,
        encoding: "utf8",
        env: { ...process.env, FIRST_TREE_EVAL_EVENTS: paths.eventsPath },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Blocked gh command");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
