import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { readEvents } from "../events.js";
import { createRunPaths } from "../paths.js";
import { createGhShim } from "../shims/gh.js";

function createShim(caseId: string): { repoRoot: string; ghPath: string; eventsPath: string; workspacePath: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "skill-evals-gh-shim-test-"));
  const packageRoot = join(repoRoot, "packages", "skill-evals");
  mkdirSync(packageRoot, { recursive: true });
  const paths = createRunPaths({ caseId, packageRoot, startedAt: "2026-06-30T00:00:00.000Z" });
  createGhShim(paths);
  return {
    repoRoot,
    ghPath: join(paths.binDir, "gh"),
    eventsPath: paths.eventsPath,
    workspacePath: paths.workspacePath,
  };
}

describe("gh eval shim", () => {
  it("simulates successful GitHub governance bootstrap calls", () => {
    const shim = createShim("unbound-github-tree-governance-bootstrap");
    try {
      const result = spawnSync(
        shim.ghPath,
        ["api", "repos/$repo/rulesets", "--method", "POST", "--input", "ruleset.json"],
        {
          cwd: shim.workspacePath,
          encoding: "utf8",
          env: {
            ...process.env,
            FIRST_TREE_EVAL_CASE_ID: "unbound-github-tree-governance-bootstrap",
            FIRST_TREE_EVAL_EVENTS: shim.eventsPath,
            FIRST_TREE_EVAL_PHASE: "model",
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("First Tree Context Repo branch rules");
      expect(readEvents(shim.eventsPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            argv: ["api", "repos/$repo/rulesets", "--method", "POST", "--input", "ruleset.json"],
            exitCode: 0,
            shimmedByEval: true,
            type: "gh_result",
          }),
        ]),
      );
    } finally {
      rmSync(shim.repoRoot, { force: true, recursive: true });
    }
  });

  it("simulates fail-closed owner resolution for recovery governance calls", () => {
    const shim = createShim("unbound-github-governance-fail-closed");
    try {
      const result = spawnSync(shim.ghPath, ["api", "repos/$repo/teams?per_page=100"], {
        cwd: shim.workspacePath,
        encoding: "utf8",
        env: {
          ...process.env,
          FIRST_TREE_EVAL_CASE_ID: "unbound-github-governance-fail-closed",
          FIRST_TREE_EVAL_EVENTS: shim.eventsPath,
          FIRST_TREE_EVAL_PHASE: "model",
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("No qualifying visible non-author team");
      expect(readEvents(shim.eventsPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            argv: ["api", "repos/$repo/teams?per_page=100"],
            exitCode: 1,
            shimmedByEval: true,
            type: "gh_result",
          }),
        ]),
      );
    } finally {
      rmSync(shim.repoRoot, { force: true, recursive: true });
    }
  });
});
