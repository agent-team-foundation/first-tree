import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readEvents } from "../../../core/events.js";
import { createRunPaths } from "../../../core/paths.js";
import { createFirstTreeShim } from "../../../core/shims/first-tree.js";
import { createGhShim } from "../../../core/shims/gh.js";
import { createGitShim } from "../../../core/shims/git.js";
import { CONTEXT_TREE_AUDIT_GATE_CASES } from "../cases.js";
import { inspectFixtureState, readRecordedVerifyExitCode, setupFixture } from "../fixture.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("context-tree-audit fixture", () => {
  it.each([
    ["mechanical", 1],
    ["strong-local", 0],
  ] as const)("records real validator result and all seven skills for %s", (scenario, expectedExitCode) => {
    const evalCase = CONTEXT_TREE_AUDIT_GATE_CASES.find((item) => item.fixture.scenario === scenario);
    expect(evalCase).toBeDefined();
    if (!evalCase) throw new Error(`Missing context-tree-audit eval case for '${scenario}'.`);
    const paths = createRunPaths({
      caseId: `audit-${scenario}`,
      packageRoot,
      startedAt: `2026-07-16T00:00:0${expectedExitCode}.000Z`,
    });
    try {
      const fixture = setupFixture(evalCase, paths);
      const agents = readFileSync(join(paths.workspacePath, "AGENTS.md"), "utf8");
      for (const skill of [
        "first-tree-welcome",
        "first-tree-seed",
        "first-tree-file-bug",
        "first-tree-read",
        "first-tree-write",
        "context-tree-review",
        "context-tree-audit",
      ]) {
        expect(agents).toContain(`\`${skill}\``);
        expect(readFileSync(join(paths.workspacePath, ".agents", "skills", skill, "SKILL.md"), "utf8")).toContain(
          `name: ${skill}`,
        );
      }
      expect(agents).toContain("loads `context-tree-audit` exclusively");
      expect(readRecordedVerifyExitCode(fixture)).toBe(expectedExitCode);
      expect(inspectFixtureState(fixture)).toEqual({
        auditWorktreeCleaned: true,
        changedBranchCount: 0,
        diffPaths: [],
        expectedContentObserved: true,
        mainHeadUnchanged: true,
        mainWorktreeClean: true,
        noGuessedTreeState: true,
        originMainExpected: true,
        unpublishedAuthoringStateClean: true,
      });
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("advances origin/main after validating the stale audit snapshot without creating a repair", () => {
    const evalCase = CONTEXT_TREE_AUDIT_GATE_CASES.find((item) => item.fixture.scenario === "stale-before-write");
    if (!evalCase) throw new Error("Missing stale-before-write audit case.");
    const paths = createRunPaths({
      caseId: evalCase.id,
      packageRoot,
      startedAt: "2026-07-16T00:00:09.000Z",
    });
    try {
      const fixture = setupFixture(evalCase, paths);
      if (!fixture.treePath || !fixture.expectation.auditWorktreePath || !fixture.expectation.headOid) {
        throw new Error("Stale audit fixture did not create a bound tree.");
      }
      const modelPaths = { ...paths, binDir: join(paths.workspacePath, ".first-tree-eval", "bin") };
      mkdirSync(modelPaths.binDir, { recursive: true });
      createFirstTreeShim(modelPaths, {
        auditFixturePath: fixture.auditFixturePath,
        modelVerifyMode: "real",
        recordedModelVerifyCwd: fixture.expectation.auditWorktreePath,
        recordedModelVerifyHead: fixture.expectation.headOid,
        recordedModelVerifyPath: fixture.verifyResultPath ?? undefined,
      });
      createGitShim(modelPaths, { auditFixturePath: fixture.auditFixturePath });
      expect(
        spawnSync(
          "git",
          ["worktree", "add", fixture.expectation.auditWorktreePath, "--detach", fixture.expectation.headOid],
          { cwd: fixture.treePath, encoding: "utf8" },
        ).status,
      ).toBe(0);
      const verify = spawnSync(join(modelPaths.binDir, "first-tree"), ["tree", "verify", "--json"], {
        cwd: fixture.expectation.auditWorktreePath,
        encoding: "utf8",
        env: { ...process.env, FIRST_TREE_EVAL_PHASE: "model" },
      });
      expect(verify.status).toBe(0);
      const gitEnv = {
        ...process.env,
        FIRST_TREE_EVAL_EVENTS: paths.eventsPath,
        FIRST_TREE_EVAL_PHASE: "model",
      };
      expect(
        spawnSync(join(modelPaths.binDir, "git"), ["-C", "context-tree", "fetch", "origin"], {
          cwd: paths.workspacePath,
          encoding: "utf8",
          env: gitEnv,
        }).status,
      ).toBe(0);
      const observed = spawnSync(
        join(modelPaths.binDir, "git"),
        ["-C", "context-tree", "rev-parse", "refs/remotes/origin/main"],
        { cwd: paths.workspacePath, encoding: "utf8", env: gitEnv },
      );
      expect(observed.status).toBe(0);
      expect(observed.stdout.trim()).toBe(fixture.expectation.advancedHeadOid);
      expect(readEvents(paths.eventsPath)).toContainEqual(
        expect.objectContaining({
          auditedHead: fixture.expectation.headOid,
          fetchObserved: true,
          observedRemoteHead: fixture.expectation.advancedHeadOid,
          type: "audit_write_freshness_observed",
        }),
      );
      expect(
        spawnSync("git", ["worktree", "remove", fixture.expectation.auditWorktreePath], {
          cwd: fixture.treePath,
          encoding: "utf8",
        }).status,
      ).toBe(0);
      expect(inspectFixtureState(fixture)).toEqual({
        auditWorktreeCleaned: true,
        changedBranchCount: 0,
        diffPaths: [],
        expectedContentObserved: true,
        mainHeadUnchanged: true,
        mainWorktreeClean: true,
        noGuessedTreeState: true,
        originMainExpected: true,
        unpublishedAuthoringStateClean: true,
      });
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("advances origin/main after authoring and leaves no unpublished branch or worktree", () => {
    const evalCase = CONTEXT_TREE_AUDIT_GATE_CASES.find((item) => item.fixture.scenario === "stale-before-publish");
    if (!evalCase) throw new Error("Missing stale-before-publish audit case.");
    const paths = createRunPaths({
      caseId: evalCase.id,
      packageRoot,
      startedAt: "2026-07-16T00:00:10.000Z",
    });
    try {
      const fixture = setupFixture(evalCase, paths);
      if (!fixture.treePath || !fixture.expectation.auditWorktreePath || !fixture.expectation.headOid) {
        throw new Error("Stale publication fixture did not create a bound tree.");
      }
      const modelPaths = { ...paths, binDir: join(paths.workspacePath, ".first-tree-eval", "bin") };
      mkdirSync(modelPaths.binDir, { recursive: true });
      createFirstTreeShim(modelPaths, {
        auditFixturePath: fixture.auditFixturePath,
        modelVerifyMode: "real",
        recordedModelVerifyCwd: fixture.expectation.auditWorktreePath,
        recordedModelVerifyHead: fixture.expectation.headOid,
        recordedModelVerifyPath: fixture.verifyResultPath ?? undefined,
      });
      createGitShim(modelPaths, { auditFixturePath: fixture.auditFixturePath });
      expect(
        spawnSync(
          "git",
          ["worktree", "add", fixture.expectation.auditWorktreePath, "--detach", fixture.expectation.headOid],
          { cwd: fixture.treePath, encoding: "utf8" },
        ).status,
      ).toBe(0);
      expect(
        spawnSync(join(modelPaths.binDir, "first-tree"), ["tree", "verify", "--json"], {
          cwd: fixture.expectation.auditWorktreePath,
          encoding: "utf8",
          env: { ...process.env, FIRST_TREE_EVAL_PHASE: "model" },
        }).status,
      ).toBe(0);
      const gitEnv = {
        ...process.env,
        FIRST_TREE_EVAL_EVENTS: paths.eventsPath,
        FIRST_TREE_EVAL_PHASE: "model",
      };
      for (const args of [
        ["-C", "context-tree", "fetch", "origin"],
        ["-C", "context-tree", "rev-parse", "refs/remotes/origin/main"],
      ]) {
        expect(
          spawnSync(join(modelPaths.binDir, "git"), args, {
            cwd: paths.workspacePath,
            encoding: "utf8",
            env: gitEnv,
          }).status,
        ).toBe(0);
      }
      const authoringWorktree = join(paths.workspacePath, ".first-tree-eval", "audit-authoring-worktree");
      expect(
        spawnSync(
          join(modelPaths.binDir, "git"),
          ["-C", "context-tree", "worktree", "add", authoringWorktree, "-b", "audit-unpublished"],
          {
            cwd: paths.workspacePath,
            encoding: "utf8",
            env: gitEnv,
          },
        ).status,
      ).toBe(0);
      writeFileSync(
        join(authoringWorktree, "system", "audit-contract.md"),
        `---\ntitle: "Audit Contract"\nowners: [eval-owner]\n---\n\n# Audit Contract\n\n## Decision\n\nAudit evidence retention is 90 days.\n`,
        "utf8",
      );
      for (const args of [
        ["-C", authoringWorktree, "add", "system/audit-contract.md"],
        ["-C", authoringWorktree, "commit", "-m", "fix: reconcile audit retention"],
      ]) {
        expect(
          spawnSync(join(modelPaths.binDir, "git"), args, {
            cwd: paths.workspacePath,
            encoding: "utf8",
            env: gitEnv,
          }).status,
        ).toBe(0);
      }
      const writerVerify = spawnSync(
        join(modelPaths.binDir, "first-tree"),
        ["tree", "verify", "--tree-path", authoringWorktree],
        {
          cwd: paths.workspacePath,
          encoding: "utf8",
          env: gitEnv,
        },
      );
      expect(writerVerify.status).toBe(0);
      expect(
        spawnSync(join(modelPaths.binDir, "git"), ["-C", "context-tree", "fetch", "origin"], {
          cwd: paths.workspacePath,
          encoding: "utf8",
          env: gitEnv,
        }).status,
      ).toBe(0);
      const observed = spawnSync(
        join(modelPaths.binDir, "git"),
        ["-C", "context-tree", "rev-parse", "refs/remotes/origin/main"],
        { cwd: paths.workspacePath, encoding: "utf8", env: gitEnv },
      );
      expect(observed.status).toBe(0);
      expect(observed.stdout.trim()).toBe(fixture.expectation.advancedHeadOid);
      expect(
        spawnSync(join(modelPaths.binDir, "git"), ["-C", "context-tree", "worktree", "remove", authoringWorktree], {
          cwd: paths.workspacePath,
          encoding: "utf8",
          env: gitEnv,
        }).status,
      ).toBe(0);
      expect(
        spawnSync(join(modelPaths.binDir, "git"), ["-C", "context-tree", "branch", "-D", "audit-unpublished"], {
          cwd: paths.workspacePath,
          encoding: "utf8",
          env: gitEnv,
        }).status,
      ).toBe(0);
      expect(
        spawnSync("git", ["worktree", "remove", fixture.expectation.auditWorktreePath], {
          cwd: fixture.treePath,
          encoding: "utf8",
        }).status,
      ).toBe(0);
      expect(inspectFixtureState(fixture)).toEqual({
        auditWorktreeCleaned: true,
        changedBranchCount: 0,
        diffPaths: [],
        expectedContentObserved: true,
        mainHeadUnchanged: true,
        mainWorktreeClean: true,
        noGuessedTreeState: true,
        originMainExpected: true,
        unpublishedAuthoringStateClean: true,
      });
      expect(readEvents(paths.eventsPath)).toContainEqual(
        expect.objectContaining({
          advancedHead: fixture.expectation.advancedHeadOid,
          type: "audit_origin_advanced_after_writer_verify",
        }),
      );
      expect(readEvents(paths.eventsPath)).toContainEqual(
        expect.objectContaining({
          auditWriterVerify: true,
          exitCode: 0,
          type: "first_tree_result",
          writerVerifyBindingValid: true,
        }),
      );
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("requires Audit-originated pull requests to remain draft", () => {
    const evalCase = CONTEXT_TREE_AUDIT_GATE_CASES.find((item) => item.fixture.scenario === "strong-local");
    if (!evalCase) throw new Error("Missing strong-local audit case.");
    const paths = createRunPaths({
      caseId: `${evalCase.id}-draft`,
      packageRoot,
      startedAt: "2026-07-16T00:00:11.000Z",
    });
    try {
      const fixture = setupFixture(evalCase, paths);
      const modelPaths = { ...paths, binDir: join(paths.workspacePath, ".first-tree-eval", "bin") };
      mkdirSync(modelPaths.binDir, { recursive: true });
      createGhShim(modelPaths, { auditFixturePath: fixture.auditFixturePath });
      const env = { ...process.env, FIRST_TREE_EVAL_EVENTS: paths.eventsPath, FIRST_TREE_EVAL_PHASE: "model" };
      const args = ["pr", "create", "--repo", fixture.expectation.repo, "--body", "Audit finding"];
      expect(
        spawnSync(join(modelPaths.binDir, "gh"), args, { cwd: paths.workspacePath, encoding: "utf8", env }).status,
      ).toBe(2);
      expect(
        spawnSync(join(modelPaths.binDir, "gh"), [...args, "--draft"], {
          cwd: paths.workspacePath,
          encoding: "utf8",
          env,
        }).status,
      ).toBe(0);
      expect(readEvents(paths.eventsPath)).toContainEqual(
        expect.objectContaining({ artifact: "pull-request", draft: true, type: "audit_artifact_created" }),
      );
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("records only successful publication from the fixture tree", () => {
    const evalCase = CONTEXT_TREE_AUDIT_GATE_CASES.find((item) => item.fixture.scenario === "strong-local");
    if (!evalCase) throw new Error("Missing strong-local audit case.");
    const paths = createRunPaths({
      caseId: `${evalCase.id}-publication`,
      packageRoot,
      startedAt: "2026-07-16T00:00:12.000Z",
    });
    try {
      const fixture = setupFixture(evalCase, paths);
      if (!fixture.treePath) throw new Error("Publication fixture did not create a bound tree.");
      const modelPaths = { ...paths, binDir: join(paths.workspacePath, ".first-tree-eval", "bin") };
      mkdirSync(modelPaths.binDir, { recursive: true });
      createGitShim(modelPaths, { auditFixturePath: fixture.auditFixturePath });
      const env = { ...process.env, FIRST_TREE_EVAL_EVENTS: paths.eventsPath, FIRST_TREE_EVAL_PHASE: "model" };
      expect(
        spawnSync(join(modelPaths.binDir, "git"), ["-C", "context-tree", "push", "origin", "missing-ref"], {
          cwd: paths.workspacePath,
          encoding: "utf8",
          env,
        }).status,
      ).not.toBe(0);

      const foreignOrigin = join(paths.runRoot, "foreign-origin.git");
      expect(spawnSync("git", ["init", "--bare", foreignOrigin], { encoding: "utf8" }).status).toBe(0);
      expect(
        spawnSync("git", ["remote", "add", "origin", foreignOrigin], {
          cwd: join(paths.workspacePath, "source-repo"),
          encoding: "utf8",
        }).status,
      ).toBe(0);
      expect(
        spawnSync(join(modelPaths.binDir, "git"), ["-C", "source-repo", "push", "origin", "main"], {
          cwd: paths.workspacePath,
          encoding: "utf8",
          env,
        }).status,
      ).toBe(0);
      expect(
        readEvents(paths.eventsPath).filter(
          (event) => (event as { type?: unknown }).type === "audit_tree_publication_succeeded",
        ),
      ).toHaveLength(0);

      expect(spawnSync("git", ["branch", "audit-publish"], { cwd: fixture.treePath, encoding: "utf8" }).status).toBe(0);
      expect(
        spawnSync(join(modelPaths.binDir, "git"), ["-C", "context-tree", "push", "origin", "audit-publish"], {
          cwd: paths.workspacePath,
          encoding: "utf8",
          env,
        }).status,
      ).toBe(0);
      expect(readEvents(paths.eventsPath)).toContainEqual(
        expect.objectContaining({
          publishedRef: "refs/heads/audit-publish",
          remote: "origin",
          repo: fixture.expectation.repo,
          type: "audit_tree_publication_succeeded",
        }),
      );
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it.each([
    "directory",
    "symlink",
    "bare-repository",
  ] as const)("detects guessed %s state when no Context Tree is bound", (shape) => {
    const evalCase = CONTEXT_TREE_AUDIT_GATE_CASES.find((item) => item.fixture.scenario === "no-binding");
    if (!evalCase) throw new Error("Missing no-binding audit case.");
    const paths = createRunPaths({
      caseId: evalCase.id,
      packageRoot,
      startedAt: "2026-07-16T00:00:10.000Z",
    });
    try {
      const fixture = setupFixture(evalCase, paths);
      expect(inspectFixtureState(fixture).noGuessedTreeState).toBe(true);
      if (shape === "directory") {
        mkdirSync(join(paths.workspacePath, "context-tree"), { recursive: true });
      } else if (shape === "symlink") {
        const target = join(paths.runRoot, "guessed-tree-target");
        mkdirSync(target, { recursive: true });
        symlinkSync(target, join(paths.workspacePath, "context-tree"), "dir");
      } else {
        expect(
          spawnSync("git", ["init", "--bare", join(paths.workspacePath, "guessed.git")], { encoding: "utf8" }).status,
        ).toBe(0);
      }
      expect(inspectFixtureState(fixture).noGuessedTreeState).toBe(false);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });
});
