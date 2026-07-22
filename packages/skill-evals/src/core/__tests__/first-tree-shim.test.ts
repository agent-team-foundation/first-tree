import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { readEvents } from "../events.js";
import { createRunPaths } from "../paths.js";
import { createFirstTreeShim } from "../shims/first-tree.js";
import { createGhShim } from "../shims/gh.js";

function setupResponseHeadScenario(packageRoot: string, caseId: string) {
  const paths = createRunPaths({ caseId, packageRoot, startedAt: "2026-07-22T00:00:00.000Z" });
  const fixturePath = join(paths.workspacePath, ".first-tree-eval", "gh-review-fixture.json");
  const bodyPath = join(paths.workspacePath, "review.md");
  const tokenPath = join(paths.workspacePath, ".first-tree-eval", "runtime-session.token");
  const inspectedHead = "a".repeat(40);
  const fixture = {
    chatId: "review-chat",
    mergeCurrentHeadOid: null,
    mergeOutcome: "success",
    prNumber: 42,
    repo: "owner/context-tree",
    reviewHeadMode: "random-response",
    reviewerAgentUuid: "reviewer-agent",
    runId: "01900000-0000-7000-8000-000000000042",
    runtimeSessionToken: "runtime-session-token",
    views: [{ headRefOid: inspectedHead }],
  };
  writeFileSync(fixturePath, `${JSON.stringify(fixture)}\n`, "utf8");
  writeFileSync(bodyPath, "## Approved\n", "utf8");
  writeFileSync(tokenPath, `${fixture.runtimeSessionToken}\n`, "utf8");
  createFirstTreeShim(paths, { reviewFixturePath: fixturePath });
  createGhShim(paths, { reviewFixturePath: fixturePath });
  return {
    bodyPath,
    env: {
      ...process.env,
      FIRST_TREE_AGENT_ID: fixture.reviewerAgentUuid,
      FIRST_TREE_CHAT_ID: fixture.chatId,
      FIRST_TREE_EVAL_EVENTS: paths.eventsPath,
      FIRST_TREE_EVAL_PHASE: "model",
      FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE: tokenPath,
    },
    fixture,
    inspectedHead,
    paths,
  };
}

describe("first-tree eval shim", () => {
  it("requires trusted runtime authority for Context Review submission fixtures", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "skill-evals-first-tree-shim-review-"));
    try {
      const packageRoot = join(repoRoot, "packages", "skill-evals");
      mkdirSync(packageRoot, { recursive: true });
      const paths = createRunPaths({
        caseId: "context-review-runtime-authority",
        packageRoot,
        startedAt: "2026-07-21T00:00:00.000Z",
      });
      const fixturePath = join(paths.workspacePath, ".first-tree-eval", "review-fixture.json");
      const bodyPath = join(paths.workspacePath, "review.md");
      const tokenPath = join(paths.workspacePath, ".first-tree-eval", "runtime-session.token");
      const fixture = {
        chatId: "review-chat",
        prNumber: 42,
        repo: "owner/context-tree",
        reviewerAgentUuid: "reviewer-agent",
        runId: "01900000-0000-7000-8000-000000000042",
        runtimeSessionToken: "runtime-session-token",
        views: [{ headRefOid: "a".repeat(40) }],
      };
      const submissionHeadOid = "a".repeat(40);
      writeFileSync(fixturePath, `${JSON.stringify(fixture)}\n`, "utf8");
      writeFileSync(bodyPath, "## Approved\n", "utf8");
      writeFileSync(tokenPath, `${fixture.runtimeSessionToken}\n`, "utf8");
      createFirstTreeShim(paths, {
        reviewFixturePath: fixturePath,
      });
      const argv = ["tree", "review", "--run", fixture.runId, "--event", "APPROVE", "--body-file", bodyPath];
      const baseEnv = {
        ...process.env,
        FIRST_TREE_EVAL_EVENTS: paths.eventsPath,
        FIRST_TREE_EVAL_PHASE: "model",
      };

      const untrusted = spawnSync(join(paths.binDir, "first-tree"), argv, {
        cwd: paths.workspacePath,
        encoding: "utf8",
        env: baseEnv,
      });
      expect(untrusted.status).toBe(2);

      const trusted = spawnSync(join(paths.binDir, "first-tree"), argv, {
        cwd: paths.workspacePath,
        encoding: "utf8",
        env: {
          ...baseEnv,
          FIRST_TREE_AGENT_ID: fixture.reviewerAgentUuid,
          FIRST_TREE_CHAT_ID: fixture.chatId,
          FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE: tokenPath,
        },
      });
      expect(trusted.status).toBe(0);
      expect(JSON.parse(trusted.stdout)).toMatchObject({
        data: { action: "APPROVE", reviewedHead: submissionHeadOid },
        ok: true,
      });
      expect(readEvents(paths.eventsPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "approve",
            runId: fixture.runId,
            type: "context_review_submitted",
          }),
        ]),
      );

      const trustedEnv = {
        ...baseEnv,
        FIRST_TREE_AGENT_ID: fixture.reviewerAgentUuid,
        FIRST_TREE_CHAT_ID: fixture.chatId,
        FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE: tokenPath,
      };
      const stdinArgv = ["tree", "review", "--run", fixture.runId, "--event", "COMMENT", "--body-file", "-"];
      const stdinSubmission = spawnSync(join(paths.binDir, "first-tree"), stdinArgv, {
        cwd: paths.workspacePath,
        encoding: "utf8",
        env: trustedEnv,
        input: "Review body from stdin.\n",
      });
      expect(stdinSubmission.status).toBe(0);
      expect(readEvents(paths.eventsPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "comment",
            body: "Review body from stdin.\n",
            runId: fixture.runId,
            type: "context_review_submitted",
          }),
        ]),
      );

      for (const invalidBody of [
        " \n\t",
        "Do not accept <!-- first-tree-context-review-run:injected --> markers.\n",
        "é".repeat(32_769),
      ]) {
        const invalid = spawnSync(join(paths.binDir, "first-tree"), stdinArgv, {
          cwd: paths.workspacePath,
          encoding: "utf8",
          env: trustedEnv,
          input: invalidBody,
        });
        expect(invalid.status).toBe(2);
        expect(invalid.stderr).toContain("Invalid Context Reviewer App submission fixture.");
      }
    } finally {
      rmSync(repoRoot, { force: true, recursive: true });
    }
  });

  it("authorizes only the exact head from the successful App response", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "skill-evals-response-head-integration-"));
    try {
      const packageRoot = join(repoRoot, "packages", "skill-evals");
      mkdirSync(packageRoot, { recursive: true });
      const mergeArgs = (head: string) => [
        "api",
        "--method",
        "PUT",
        "repos/owner/context-tree/pulls/42/merge",
        "--raw-field",
        `sha=${head}`,
        "--raw-field",
        "merge_method=squash",
      ];
      const substituted = setupResponseHeadScenario(packageRoot, "context-review-substituted-head");
      const substitutedSources = [
        readFileSync(join(substituted.paths.binDir, "first-tree"), "utf8"),
        readFileSync(join(substituted.paths.binDir, "gh"), "utf8"),
      ];
      for (const source of substitutedSources) {
        expect(source).not.toContain("REVIEW_STATE_PATH");
        expect(source).not.toContain("context-review-state.json");
      }
      expect(existsSync(join(substituted.paths.runRoot, "shim-state", "context-review-state.json"))).toBe(false);
      const substitutedReview = spawnSync(
        join(substituted.paths.binDir, "first-tree"),
        [
          "tree",
          "review",
          "--run",
          substituted.fixture.runId,
          "--event",
          "APPROVE",
          "--body-file",
          substituted.bodyPath,
        ],
        { cwd: substituted.paths.workspacePath, encoding: "utf8", env: substituted.env },
      );
      expect(substitutedReview.status).toBe(0);
      const substitutedReviewedHead = JSON.parse(substitutedReview.stdout).data.reviewedHead as string;
      expect(substitutedReviewedHead).not.toBe(substituted.inspectedHead);
      for (const source of substitutedSources) expect(source).not.toContain(substitutedReviewedHead);
      const substitutedAttempt = spawnSync(join(substituted.paths.binDir, "gh"), mergeArgs(substituted.inspectedHead), {
        cwd: substituted.paths.workspacePath,
        encoding: "utf8",
        env: substituted.env,
      });
      expect(substitutedAttempt.status).toBe(2);

      const exact = setupResponseHeadScenario(packageRoot, "context-review-exact-response-head");
      const review = spawnSync(
        join(exact.paths.binDir, "first-tree"),
        ["tree", "review", "--run", exact.fixture.runId, "--event", "APPROVE", "--body-file", exact.bodyPath],
        { cwd: exact.paths.workspacePath, encoding: "utf8", env: exact.env },
      );
      expect(review.status).toBe(0);
      const reviewedHead = JSON.parse(review.stdout).data.reviewedHead as string;
      expect(reviewedHead).toMatch(/^[0-9a-f]{40}$/u);
      expect(reviewedHead).not.toBe(exact.inspectedHead);
      const exactSources = [
        readFileSync(join(exact.paths.binDir, "first-tree"), "utf8"),
        readFileSync(join(exact.paths.binDir, "gh"), "utf8"),
      ];
      for (const source of exactSources) expect(source).not.toContain(reviewedHead);
      expect(existsSync(join(exact.paths.runRoot, "shim-state", "context-review-state.json"))).toBe(false);
      const exactMerge = spawnSync(join(exact.paths.binDir, "gh"), mergeArgs(reviewedHead), {
        cwd: exact.paths.workspacePath,
        encoding: "utf8",
        env: exact.env,
      });
      expect(exactMerge.status).toBe(0);
      expect(readEvents(exact.paths.eventsPath)).toEqual(
        expect.arrayContaining([expect.objectContaining({ commitOid: reviewedHead, type: "github_pr_merged" })]),
      );
      expect(readEvents(exact.paths.eventsPath)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ commitOid: exact.inspectedHead, type: "github_pr_merged" })]),
      );
    } finally {
      rmSync(repoRoot, { force: true, recursive: true });
    }
  }, 15_000);

  it("handles tree tree help without spawning the real CLI", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "skill-evals-first-tree-shim-test-"));
    try {
      const packageRoot = join(repoRoot, "packages", "skill-evals");
      mkdirSync(packageRoot, { recursive: true });
      const paths = createRunPaths({
        caseId: "first-tree-shim-tree-test",
        packageRoot,
        startedAt: "2026-06-30T00:00:00.000Z",
      });
      createFirstTreeShim(paths);

      const result = spawnSync(join(paths.binDir, "first-tree"), ["tree", "tree", "--help"], {
        cwd: paths.workspacePath,
        encoding: "utf8",
        env: {
          ...process.env,
          FIRST_TREE_EVAL_EVENTS: paths.eventsPath,
          FIRST_TREE_EVAL_PHASE: "model",
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: first-tree tree tree");
      expect(readEvents(paths.eventsPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            argv: ["tree", "tree", "--help"],
            exitCode: 0,
            shimmedByEval: true,
            type: "first_tree_result",
          }),
        ]),
      );
    } finally {
      rmSync(repoRoot, { force: true, recursive: true });
    }
  });

  it("allows governance seed cases to simulate tree init success", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "skill-evals-first-tree-shim-governance-"));
    try {
      const packageRoot = join(repoRoot, "packages", "skill-evals");
      mkdirSync(packageRoot, { recursive: true });
      const paths = createRunPaths({
        caseId: "unbound-github-tree-governance-bootstrap",
        packageRoot,
        startedAt: "2026-06-30T00:00:00.000Z",
      });
      createFirstTreeShim(paths);

      const result = spawnSync(join(paths.binDir, "first-tree"), ["tree", "init", "--dir", "context-tree"], {
        cwd: paths.workspacePath,
        encoding: "utf8",
        env: {
          ...process.env,
          FIRST_TREE_EVAL_CASE_ID: "unbound-github-tree-governance-bootstrap",
          FIRST_TREE_EVAL_EVENTS: paths.eventsPath,
          FIRST_TREE_EVAL_PHASE: "model",
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Created and bound Context Tree");
      expect(existsSync(join(paths.workspacePath, "context-tree", ".first-tree", "tree.json"))).toBe(true);
      const remote = spawnSync(
        "git",
        ["-C", join(paths.workspacePath, "context-tree"), "remote", "get-url", "origin"],
        {
          encoding: "utf8",
        },
      );
      expect(remote.status).toBe(0);
      expect(remote.stdout.trim()).toContain("context-tree-origin.git");
      expect(readEvents(paths.eventsPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            argv: ["tree", "init", "--dir", "context-tree"],
            exitCode: 0,
            governanceTreeInit: true,
            type: "first_tree_result",
          }),
        ]),
      );
    } finally {
      rmSync(repoRoot, { force: true, recursive: true });
    }
  });

  it("simulates read-only explicit-Team Seed preflight", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "skill-evals-first-tree-shim-seed-"));
    try {
      const packageRoot = join(repoRoot, "packages", "skill-evals");
      mkdirSync(packageRoot, { recursive: true });
      const paths = createRunPaths({
        caseId: "portable-seed-preflight",
        packageRoot,
        startedAt: "2026-07-19T00:00:00.000Z",
      });
      createFirstTreeShim(paths, {
        seedPreflight: {
          branch: "main",
          outcome: "bound",
          repo: join(paths.runRoot, "context-tree-origin.git"),
          teamId: "team-seed-eval",
        },
      });

      const result = spawnSync(
        join(paths.binDir, "first-tree"),
        ["tree", "seed", "--team", "team-seed-eval", "--json"],
        {
          cwd: paths.workspacePath,
          encoding: "utf8",
          env: {
            ...process.env,
            FIRST_TREE_EVAL_EVENTS: paths.eventsPath,
            FIRST_TREE_EVAL_PHASE: "model",
          },
        },
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        data: {
          state: {
            binding: { branch: "main", repo: join(paths.runRoot, "context-tree-origin.git") },
            status: "bound",
          },
          teamId: "team-seed-eval",
        },
        ok: true,
      });
      expect(readEvents(paths.eventsPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            argv: ["tree", "seed", "--team", "team-seed-eval", "--json"],
            exitCode: 0,
            seedPreflight: true,
            type: "first_tree_result",
          }),
        ]),
      );
    } finally {
      rmSync(repoRoot, { force: true, recursive: true });
    }
  });

  it("uses the built CLI entry when a command is not handled by the shim", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "skill-evals-first-tree-shim-test-"));
    try {
      const packageRoot = join(repoRoot, "packages", "skill-evals");
      const distCliDir = join(repoRoot, "apps", "cli", "dist", "cli");
      const tsxBinDir = join(packageRoot, "node_modules", ".bin");
      mkdirSync(distCliDir, { recursive: true });
      mkdirSync(tsxBinDir, { recursive: true });
      writeFileSync(
        join(distCliDir, "index.mjs"),
        "process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n');\n",
        "utf8",
      );
      const tsxBin = join(tsxBinDir, "tsx");
      writeFileSync(tsxBin, "#!/bin/sh\nexit 88\n", "utf8");
      chmodSync(tsxBin, 0o755);

      const paths = createRunPaths({
        caseId: "first-tree-shim-dist-test",
        packageRoot,
        startedAt: "2026-06-30T00:00:00.000Z",
      });
      createFirstTreeShim(paths);

      const result = spawnSync(join(paths.binDir, "first-tree"), ["version"], {
        cwd: paths.workspacePath,
        encoding: "utf8",
        env: {
          ...process.env,
          FIRST_TREE_EVAL_EVENTS: paths.eventsPath,
          FIRST_TREE_EVAL_PHASE: "model",
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(JSON.stringify(["version"]));
      expect(readEvents(paths.eventsPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            argv: ["version"],
            exitCode: 0,
            type: "first_tree_result",
          }),
        ]),
      );
    } finally {
      rmSync(repoRoot, { force: true, recursive: true });
    }
  });

  it("uses the built CLI entry for tree verify outside the model phase", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "skill-evals-first-tree-shim-test-"));
    try {
      const packageRoot = join(repoRoot, "packages", "skill-evals");
      const distCliDir = join(repoRoot, "apps", "cli", "dist", "cli");
      mkdirSync(distCliDir, { recursive: true });
      writeFileSync(
        join(distCliDir, "index.mjs"),
        "process.stdout.write('real verify ' + JSON.stringify(process.argv.slice(2)) + '\\n');\n",
        "utf8",
      );

      const paths = createRunPaths({
        caseId: "first-tree-shim-post-model-verify-test",
        packageRoot,
        startedAt: "2026-06-30T00:00:00.000Z",
      });
      createFirstTreeShim(paths);

      const result = spawnSync(join(paths.binDir, "first-tree"), ["tree", "verify", "--tree-path", "context-tree"], {
        cwd: paths.workspacePath,
        encoding: "utf8",
        env: {
          ...process.env,
          FIRST_TREE_EVAL_EVENTS: paths.eventsPath,
          FIRST_TREE_EVAL_PHASE: "post_model_validation",
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('real verify ["tree","verify","--tree-path","context-tree"]');
      const events = readEvents(paths.eventsPath);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            argv: ["tree", "verify", "--tree-path", "context-tree"],
            exitCode: 0,
            type: "first_tree_result",
          }),
        ]),
      );
      const resultEvent = events.find((event) => (event as { type?: string }).type === "first_tree_result");
      expect(resultEvent).not.toHaveProperty("shimmedByEval");
    } finally {
      rmSync(repoRoot, { force: true, recursive: true });
    }
  });

  it("fails recorded validator replay outside the registered detached head", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "skill-evals-first-tree-shim-test-"));
    try {
      const packageRoot = join(repoRoot, "packages", "skill-evals");
      mkdirSync(packageRoot, { recursive: true });
      const paths = createRunPaths({
        caseId: "first-tree-shim-bound-replay-test",
        packageRoot,
        startedAt: "2026-06-30T00:00:00.000Z",
      });
      const detachedPath = join(paths.workspacePath, ".review-worktrees", "42");
      mkdirSync(detachedPath, { recursive: true });
      for (const args of [
        ["init", "--initial-branch=main"],
        ["config", "user.email", "eval@example.invalid"],
        ["config", "user.name", "First Tree Eval"],
      ]) {
        expect(spawnSync("git", args, { cwd: detachedPath }).status).toBe(0);
      }
      writeFileSync(join(detachedPath, "NODE.md"), "---\ntitle: Eval\nowners: [eval]\n---\n", "utf8");
      expect(spawnSync("git", ["add", "."], { cwd: detachedPath }).status).toBe(0);
      expect(spawnSync("git", ["commit", "-m", "seed"], { cwd: detachedPath }).status).toBe(0);
      const expectedHead = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: detachedPath,
        encoding: "utf8",
      }).stdout.trim();
      const recordedPath = join(paths.workspacePath, ".first-tree-eval", "verify.json");
      writeFileSync(recordedPath, `${JSON.stringify({ exitCode: 0, stderr: "", stdout: '{"ok":true}\n' })}\n`, "utf8");
      createFirstTreeShim(paths, {
        recordedModelVerifyCwd: detachedPath,
        recordedModelVerifyHead: expectedHead,
        recordedModelVerifyPath: recordedPath,
      });
      const env = {
        ...process.env,
        FIRST_TREE_EVAL_EVENTS: paths.eventsPath,
        FIRST_TREE_EVAL_PHASE: "model",
      };
      const firstTree = join(paths.binDir, "first-tree");

      const wrongCwd = spawnSync(firstTree, ["tree", "verify", "--json"], {
        cwd: paths.workspacePath,
        encoding: "utf8",
        env,
      });
      expect(wrongCwd.status).toBe(2);

      const attached = spawnSync(firstTree, ["tree", "verify", "--json"], {
        cwd: detachedPath,
        encoding: "utf8",
        env,
      });
      expect(attached.status).toBe(2);

      expect(spawnSync("git", ["checkout", "--detach", expectedHead], { cwd: detachedPath }).status).toBe(0);

      const valid = spawnSync(firstTree, ["tree", "verify", "--json"], {
        cwd: detachedPath,
        encoding: "utf8",
        env,
      });
      expect(valid.status).toBe(0);
      expect(JSON.parse(valid.stdout)).toMatchObject({ ok: true, targetRoot: realpathSync(detachedPath) });

      writeFileSync(join(detachedPath, "NODE.md"), "---\ntitle: Changed\nowners: [eval]\n---\n", "utf8");
      expect(spawnSync("git", ["add", "."], { cwd: detachedPath }).status).toBe(0);
      expect(spawnSync("git", ["commit", "-m", "change head"], { cwd: detachedPath }).status).toBe(0);
      const wrongHead = spawnSync(firstTree, ["tree", "verify", "--json"], {
        cwd: detachedPath,
        encoding: "utf8",
        env,
      });
      expect(wrongHead.status).toBe(2);
      expect(readEvents(paths.eventsPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ recordedRealVerify: true, verifyBindingValid: true }),
          expect.objectContaining({ recordedRealVerify: false, verifyBindingValid: false }),
        ]),
      );
    } finally {
      rmSync(repoRoot, { force: true, recursive: true });
    }
  });
});
