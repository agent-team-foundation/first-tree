import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readEvents } from "../../../core/events.js";
import { createRunPaths } from "../../../core/paths.js";
import { createEvalReporter } from "../../../core/reporter.js";
import { createFirstTreeShim } from "../../../core/shims/first-tree.js";
import { findFirstTreeReadCase } from "../cases.js";
import { setupFixture } from "../fixture.js";

describe("first-tree-read source provenance fixtures", () => {
  it("declares a credential-free managed binding that can produce exact source links", () => {
    const evalCase = findFirstTreeReadCase("tree-software-trigger");
    if (evalCase === null) throw new Error("missing managed read case");

    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const paths = createRunPaths({
      caseId: evalCase.id,
      packageRoot,
      startedAt: new Date().toISOString(),
    });

    try {
      const contextTreePath = setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
      if (contextTreePath === null) throw new Error("managed fixture must create a Context Tree");
      const remote = spawnSync("git", ["remote", "get-url", "origin"], {
        cwd: contextTreePath,
        encoding: "utf8",
      });
      const briefing = readFileSync(join(paths.workspacePath, "AGENTS.md"), "utf8");

      expect(remote.status).toBe(0);
      expect(remote.stdout.trim()).toBe("https://github.com/example/context-tree.git");
      expect(briefing).toContain("Context Tree binding repository `https://github.com/example/context-tree.git`");
      expect(briefing).toContain("binding branch `main`");
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("routes one SCOPE candidate before materializing its detached exact snapshot", () => {
    const evalCase = findFirstTreeReadCase("byo-scope-route-trigger");
    if (evalCase === null) throw new Error("missing SCOPE-routed BYO read case");

    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const paths = createRunPaths({
      caseId: evalCase.id,
      packageRoot,
      startedAt: new Date().toISOString(),
    });

    try {
      createFirstTreeShim(paths);
      const fixtureSource = setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
      expect(fixtureSource).toBe(join(paths.runRoot, "byo-context-tree-source"));
      expect(existsSync(join(paths.workspacePath, ".first-tree", "workspace.json"))).toBe(false);
      expect(existsSync(join(paths.workspacePath, "context-tree"))).toBe(false);

      const firstTree = join(paths.binDir, "first-tree");
      const snapshotPath = join(paths.runRoot, "task-snapshot");
      const env = {
        ...process.env,
        FIRST_TREE_EVAL_CASE_ID: evalCase.id,
        FIRST_TREE_EVAL_EVENTS: paths.eventsPath,
        FIRST_TREE_EVAL_PHASE: "model",
      };

      const route = spawnSync(
        firstTree,
        ["--json", "context", "route", "--provider", "codex", "--pathless", "--session-candidate", "eval-receipt"],
        {
          cwd: paths.workspacePath,
          encoding: "utf8",
          env,
        },
      );
      expect(route.status).toBe(0);
      const routeEnvelope = JSON.parse(route.stdout) as {
        data: { candidates: Array<{ candidateId: string; scope: { body: string } }> };
      };
      expect(routeEnvelope.data.candidates[0]?.scope.body).toContain("authentication");
      const candidateId = routeEnvelope.data.candidates[0]?.candidateId;
      if (!candidateId) throw new Error("expected a routed BYO candidate");

      const activationArgv = ["--json", "context", "snapshot", "--candidate", candidateId];
      const obsoleteSnapshotOption = spawnSync(firstTree, [...activationArgv, "--snapshot", snapshotPath], {
        cwd: paths.workspacePath,
        encoding: "utf8",
        env,
      });
      expect(obsoleteSnapshotOption.status).toBe(2);
      expect(existsSync(snapshotPath)).toBe(false);
      const activation = spawnSync(firstTree, activationArgv, {
        cwd: paths.workspacePath,
        encoding: "utf8",
        env,
      });
      expect(activation.status).toBe(0);
      const envelope = JSON.parse(activation.stdout) as {
        data: { binding: { repo: string }; commit: string; snapshotPath: string; teamId: string };
      };
      const receipt = envelope.data;
      expect(receipt).toMatchObject({ teamId: "team-byo-read-eval" });
      expect(receipt.snapshotPath).not.toBe(snapshotPath);
      expect(receipt.snapshotPath).toContain(paths.runRoot);
      expect(receipt.binding.repo).toBe("https://github.com/example/context-tree.git");

      const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: receipt.snapshotPath, encoding: "utf8" });
      const symbolic = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], {
        cwd: receipt.snapshotPath,
        encoding: "utf8",
      });
      const remotes = spawnSync("git", ["remote"], { cwd: receipt.snapshotPath, encoding: "utf8" });
      expect(head.stdout.trim()).toBe(receipt.commit);
      expect(symbolic.status).not.toBe(0);
      expect(remotes.stdout.trim()).toBe("");

      const hierarchyHelp = spawnSync(firstTree, ["tree", "tree", "--help"], {
        cwd: receipt.snapshotPath,
        encoding: "utf8",
        env,
      });
      const selector = spawnSync(firstTree, ["tree", "tree", "--no-pull", "systems/server/auth"], {
        cwd: receipt.snapshotPath,
        encoding: "utf8",
        env,
      });
      expect(hierarchyHelp.status).toBe(0);
      expect(selector.status).toBe(0);
      expect(selector.stdout).toContain("jwt/NODE.md");

      const activationResults = readEvents(paths.eventsPath).filter(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          (event as { type?: string }).type === "first_tree_result" &&
          (event as { exitCode?: number }).exitCode === 0 &&
          (event as { argv?: string[] }).argv?.includes("snapshot") &&
          (event as { argv?: string[] }).argv?.includes("context") &&
          !(event as { argv?: string[] }).argv?.includes("--help"),
      );
      expect(activationResults).toEqual([
        expect.objectContaining({
          authorityChecks: 1,
          exactCommit: receipt.commit,
          strictFetches: 1,
          teamId: "team-byo-read-eval",
        }),
      ]);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });
});
