import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createRunPaths } from "../../../core/paths.js";
import { createEvalReporter } from "../../../core/reporter.js";
import { FIRST_TREE_SEED_PERIODIC_CASES } from "../cases.js";
import { setupFixture } from "../fixture.js";
import { findFirstTreeSeedPeriodicCase } from "../periodic.js";

describe("first-tree-seed periodic cases", () => {
  it("declares the real first-tree source realism case as the only implemented periodic row", () => {
    expect(FIRST_TREE_SEED_PERIODIC_CASES.map((evalCase) => evalCase.id)).toEqual([
      "first-tree-seed-real-first-tree-source-periodic",
    ]);
    expect(FIRST_TREE_SEED_PERIODIC_CASES[0]?.status).toBe("implemented");
    expect(FIRST_TREE_SEED_PERIODIC_CASES[0]?.fixture.sourceRepoState).toBe("real-first-tree-bare-readable");
  });

  it("finds the periodic realism case by id", () => {
    expect(findFirstTreeSeedPeriodicCase("first-tree-seed-real-first-tree-source-periodic")?.tier).toBe("periodic");
    expect(findFirstTreeSeedPeriodicCase("missing-periodic-case")).toBeNull();
  });

  it("builds the real-source fixture from a run-scoped origin instead of the developer checkout", () => {
    const evalCase = findFirstTreeSeedPeriodicCase("first-tree-seed-real-first-tree-source-periodic");
    if (evalCase === null) throw new Error("missing seed real-source periodic case");

    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const paths = createRunPaths({
      caseId: "seed-real-source-fixture-test",
      packageRoot,
      startedAt: new Date().toISOString(),
    });

    try {
      setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));
      const sourceRepoPath = join(paths.workspacePath, "source-repos", "source-repo");
      const origin = execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: sourceRepoPath,
        encoding: "utf8",
      }).trim();
      const visibleHead = execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], {
        cwd: sourceRepoPath,
        encoding: "utf8",
      }).trim();
      const repoHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: paths.repoRoot,
        encoding: "utf8",
      }).trim();
      const sourceOriginRemotes = execFileSync("git", ["remote", "-v"], {
        cwd: join(paths.workspacePath, ".first-tree-eval", "source-origin"),
        encoding: "utf8",
      });

      expect(origin).not.toBe(paths.repoRoot);
      expect(origin).toBe(join(paths.workspacePath, ".first-tree-eval", "source-origin"));
      expect(sourceOriginRemotes).not.toContain(paths.repoRoot);
      expect(visibleHead).toBe(repoHead);
      execFileSync("git", ["fetch", "origin"], { cwd: sourceRepoPath });
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });
});
