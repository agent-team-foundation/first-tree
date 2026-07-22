import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createRunPaths } from "../../../core/paths.js";
import { CONTEXT_TREE_REVIEW_GATE_CASES } from "../cases.js";
import { inspectFixtureIntegrity, setupFixture } from "../fixture.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("context-tree-review fixture", () => {
  it.each([
    ["passing", 0],
    ["validator-failure", 1],
  ] as const)("records the real source validator result for %s", (scenario, expectedExitCode) => {
    const evalCase = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === scenario);
    expect(evalCase).toBeDefined();
    if (!evalCase) throw new Error(`Missing context-tree-review eval case for '${scenario}'.`);
    const paths = createRunPaths({
      caseId: `review-${scenario}`,
      packageRoot,
      startedAt: `2026-07-14T00:00:0${expectedExitCode}.000Z`,
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
        "first-tree-qa",
      ]) {
        expect(agents).toContain(`\`${skill}\``);
        expect(readFileSync(join(paths.workspacePath, ".agents", "skills", skill, "SKILL.md"), "utf8")).toContain(
          `name: ${skill}`,
        );
      }
      expect(agents).toContain("loads `context-tree-review` exclusively");
      expect(fixture.expectation.chatId).toBe("review-eval-chat");
      expect(fixture.expectation.reviewerAgentUuid).toBe("reviewer-eval-agent");
      expect(readFileSync(fixture.expectation.runtimeSessionTokenFile, "utf8").trim()).toBe(
        fixture.expectation.runtimeSessionToken,
      );
      expect(inspectFixtureIntegrity(fixture)).toEqual({
        mainHeadUnchanged: true,
        mainWorktreeClean: true,
        originRefsUnchanged: true,
        reviewWorktreeCleaned: true,
        treeConfigUnchanged: true,
        treeRefsUnchanged: true,
        treeWorktreesUnchanged: true,
      });
      const result = JSON.parse(readFileSync(fixture.verifyResultPath, "utf8")) as { exitCode: number; stdout: string };
      expect(result.exitCode).toBe(expectedExitCode);
      const summary = JSON.parse(result.stdout) as { findings: Array<{ code: string }>; ok: boolean };
      expect(summary.ok).toBe(expectedExitCode === 0);
      if (scenario === "validator-failure") {
        expect(summary.findings.map((finding) => finding.code)).toContain("TREE_OWNERS_INVALID");
      }
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });
});
