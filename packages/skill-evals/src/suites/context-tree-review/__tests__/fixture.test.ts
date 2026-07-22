import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runCommand } from "../../../core/commands.js";
import { createRunPaths } from "../../../core/paths.js";
import { CONTEXT_TREE_REVIEW_GATE_CASES } from "../cases.js";
import { inspectFixtureIntegrity, type ReviewFixture, setupFixture } from "../fixture.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function fixtureCase(scenario: string) {
  const evalCase = CONTEXT_TREE_REVIEW_GATE_CASES.find((item) => item.fixture.scenario === scenario);
  expect(evalCase).toBeDefined();
  if (!evalCase) throw new Error(`Missing context-tree-review eval case for '${scenario}'.`);
  return evalCase;
}

function git(fixture: ReviewFixture, args: string[], cwd = fixture.treePath): ReturnType<typeof runCommand> {
  return runCommand("git", args, cwd);
}

function applySemanticRepair(fixture: ReviewFixture): void {
  expect(git(fixture, ["worktree", "add", fixture.repairWorktreePath, "review-change"]).exitCode).toBe(0);
  writeFileSync(
    join(fixture.repairWorktreePath, "system", "review-contract.md"),
    '---\ntitle: "Review Contract"\nowners: [eval-owner]\n---\n\n# Review Contract\n\n## Decision\n\nThe GitHub App publishes the formal Context Tree review verdict.\n\n## Rationale\n\nOne provider-native verdict keeps the review auditable while the local reviewer identity performs safe repairs.\n',
    "utf8",
  );
  expect(git(fixture, ["add", "system/review-contract.md"], fixture.repairWorktreePath).exitCode).toBe(0);
  expect(git(fixture, ["commit", "-m", "fix: repair review contract"], fixture.repairWorktreePath).exitCode).toBe(0);
}

describe("context-tree-review fixture", () => {
  it.each([
    ["passing", 0],
    ["validator-failure", 1],
  ] as const)("records the real source validator result for %s", (scenario, expectedExitCode) => {
    const paths = createRunPaths({
      caseId: `review-${scenario}`,
      packageRoot,
      startedAt: `2026-07-14T00:00:0${expectedExitCode}.000Z`,
    });
    try {
      const fixture = setupFixture(fixtureCase(scenario), paths);
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
      const refs = git(fixture, ["for-each-ref", "--format=%(refname)"], fixture.originPath).stdout;
      expect(refs).toContain("refs/heads/review-change");
      expect(refs).toContain("refs/pull/42/head");
      expect(readFileSync(join(fixture.originPath, "hooks", "post-receive"), "utf8")).toContain("refs/pull/42/head");
      const result = JSON.parse(readFileSync(fixture.verifyResultPath, "utf8")) as {
        exitCode: number;
        stdout: string;
      };
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

  it("allows exactly one normal repair commit and mirrors its source push to the PR ref", () => {
    const paths = createRunPaths({
      caseId: "review-repair-success",
      packageRoot,
      startedAt: "2026-07-14T00:00:03.000Z",
    });
    try {
      const fixture = setupFixture(fixtureCase("semantic-failure"), paths);
      applySemanticRepair(fixture);
      expect(
        git(fixture, ["push", "origin", "HEAD:refs/heads/review-change"], fixture.repairWorktreePath).exitCode,
      ).toBe(0);
      expect(git(fixture, ["worktree", "remove", fixture.repairWorktreePath]).exitCode).toBe(0);
      const inspected = inspectFixtureIntegrity(fixture);
      expect(inspected.finalHeadOid).not.toBe(fixture.expectation.headOid);
      expect(inspected.finalHeadOid).toBe(inspected.sourceHeadOid);
      expect(
        Object.entries(inspected)
          .filter(
            ([key, value]) => !["finalDiffEmpty", "repairPathsRemoved"].includes(key) && typeof value === "boolean",
          )
          .every(([, value]) => value),
      ).toBe(true);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("rejects a source push without touching the origin and preserves the normal repair commit", () => {
    const paths = createRunPaths({
      caseId: "review-repair-push-denied",
      packageRoot,
      startedAt: "2026-07-14T00:00:04.000Z",
    });
    try {
      const fixture = setupFixture(fixtureCase("push-denied"), paths);
      applySemanticRepair(fixture);
      const pushed = git(fixture, ["push", "origin", "HEAD:refs/heads/review-change"], fixture.repairWorktreePath);
      expect(pushed.exitCode).not.toBe(0);
      expect(pushed.stderr).toContain("review-change push denied by eval fixture");
      expect(git(fixture, ["worktree", "remove", fixture.repairWorktreePath]).exitCode).toBe(0);
      const inspected = inspectFixtureIntegrity(fixture);
      expect(inspected.finalHeadOid).toBe(fixture.expectation.headOid);
      expect(inspected.sourceHeadOid).not.toBe(fixture.expectation.headOid);
      expect(
        Object.entries(inspected)
          .filter(
            ([key, value]) => !["finalDiffEmpty", "repairPathsRemoved"].includes(key) && typeof value === "boolean",
          )
          .every(([, value]) => value),
      ).toBe(true);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("rejects source mutation when the case does not authorize repair", () => {
    const paths = createRunPaths({
      caseId: "review-no-repair-push-denied",
      packageRoot,
      startedAt: "2026-07-14T00:00:05.000Z",
    });
    try {
      const fixture = setupFixture(fixtureCase("passing"), paths);
      expect(git(fixture, ["worktree", "add", fixture.repairWorktreePath, "review-change"]).exitCode).toBe(0);
      writeFileSync(join(fixture.repairWorktreePath, "system", "unexpected.md"), "unexpected\n", "utf8");
      expect(git(fixture, ["add", "system/unexpected.md"], fixture.repairWorktreePath).exitCode).toBe(0);
      expect(
        git(fixture, ["commit", "-m", "test: attempt unexpected mutation"], fixture.repairWorktreePath).exitCode,
      ).toBe(0);
      const pushed = git(fixture, ["push", "origin", "HEAD:refs/heads/review-change"], fixture.repairWorktreePath);
      expect(pushed.exitCode).not.toBe(0);
      expect(pushed.stderr).toContain("review-change push denied by eval fixture");
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });
});
