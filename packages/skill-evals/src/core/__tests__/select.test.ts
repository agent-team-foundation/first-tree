import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { changedFilesFromGit, selectSkillEvalRecommendations } from "../select.js";

function runGit(repoRoot: string, args: readonly string[]): void {
  execFileSync("git", args, {
    cwd: repoRoot,
    stdio: "ignore",
  });
}

const HUMAN_ONLY_NOTE =
  "Model-backed gate, quality, and periodic evals are never selected automatically; run them only on explicit human instruction.";

describe("skill eval selection", () => {
  it.each([
    ["skills/first-tree-write/SKILL.md", "first-tree-write"],
    ["skills/first-tree-read/SKILL.md", "first-tree-read"],
    ["skills/first-tree-seed/SKILL.md", "first-tree-seed"],
    ["skills/first-tree-qa/SKILL.md", "first-tree-qa"],
  ])("selects only the no-model floor for %s", (path, skill) => {
    const summary = selectSkillEvalRecommendations([path], "main");

    expect(summary.recommendations).toEqual([
      {
        command: `pnpm --filter @first-tree/skill-evals eval:floor -- --suite ${skill}`,
        kind: "floor",
        reason: `${path} touches ${skill}`,
        suite: skill,
      },
    ]);
    expect(summary.notes).toEqual([HUMAN_ONLY_NOTE]);
  });

  it.each([
    "packages/skill-evals/src/core/judge/schema.ts",
    "packages/skill-evals/src/core/provider/claude.ts",
    "packages/client/src/runtime/agent-briefing.ts",
    "packages/skill-evals/src/core/periodic.ts",
    "packages/skill-evals/src/suites/quality/runner.ts",
  ])("selects only the no-model floor for shared or model-backed infrastructure changes: %s", (path) => {
    const summary = selectSkillEvalRecommendations([path]);

    expect(summary.recommendations).toHaveLength(1);
    expect(summary.recommendations[0]).toMatchObject({
      command: "pnpm --filter @first-tree/skill-evals eval:floor",
      kind: "floor",
      suite: "all",
    });
    expect(summary.notes).toEqual([HUMAN_ONLY_NOTE]);
  });

  it("selects only suite-scoped floors when several skills change", () => {
    const summary = selectSkillEvalRecommendations([
      "skills/first-tree-write/SKILL.md",
      "skills/first-tree-seed/SKILL.md",
      "packages/qa/templates/qa-report.md",
    ]);

    expect(summary.recommendations.map((recommendation) => recommendation.command)).toEqual([
      "pnpm --filter @first-tree/skill-evals eval:floor -- --suite first-tree-qa",
      "pnpm --filter @first-tree/skill-evals eval:floor -- --suite first-tree-seed",
      "pnpm --filter @first-tree/skill-evals eval:floor -- --suite first-tree-write",
    ]);
    expect(summary.recommendations.every((recommendation) => recommendation.kind === "floor")).toBe(true);
    expect(summary.notes).toEqual([HUMAN_ONLY_NOTE]);
  });

  it("selects a suite-scoped floor for periodic runner changes", () => {
    const path = "packages/skill-evals/src/suites/first-tree-welcome/periodic.ts";
    const summary = selectSkillEvalRecommendations([path]);

    expect(summary.recommendations).toEqual([
      {
        command: "pnpm --filter @first-tree/skill-evals eval:floor -- --suite first-tree-welcome",
        kind: "floor",
        reason: `${path} touches periodic eval framework`,
        suite: "first-tree-welcome",
      },
    ]);
    expect(summary.notes).toEqual([HUMAN_ONLY_NOTE]);
  });

  it("does not recommend skill evals for unrelated files", () => {
    const summary = selectSkillEvalRecommendations(["packages/client/src/runtime/agent-slot.ts"]);

    expect(summary.recommendations).toEqual([]);
    expect(summary.notes).toEqual(["No skill-eval-related changes were detected."]);
  });

  it.each(["first-tree-file-bug"])("emits an explicit note for unevaluated shipped skill %s", (skill) => {
    const path = `skills/${skill}/SKILL.md`;
    const summary = selectSkillEvalRecommendations([path]);

    expect(summary.recommendations).toEqual([]);
    expect(summary.notes).toEqual([
      `${path} belongs to ${skill}, a shipped skill intentionally outside skill-evals (see UNEVALUATED_SHIPPED_SKILLS); no eval selected.`,
    ]);
  });

  it("includes untracked working-tree files when selecting from git", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "skill-evals-select-test-"));
    try {
      runGit(repoRoot, ["init", "-b", "main"]);
      runGit(repoRoot, ["config", "user.email", "test@example.com"]);
      runGit(repoRoot, ["config", "user.name", "Test User"]);
      writeFileSync(join(repoRoot, "README.md"), "initial\n", "utf8");
      runGit(repoRoot, ["add", "README.md"]);
      runGit(repoRoot, ["commit", "-m", "initial"]);
      runGit(repoRoot, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

      const newFile = join(repoRoot, "packages", "skill-evals", "src", "core", "select.ts");
      mkdirSync(join(repoRoot, "packages", "skill-evals", "src", "core"), { recursive: true });
      writeFileSync(newFile, "export const value = true;\n", "utf8");

      expect(changedFilesFromGit(repoRoot, "main")).toContain("packages/skill-evals/src/core/select.ts");
    } finally {
      rmSync(repoRoot, { force: true, recursive: true });
    }
  });
});
