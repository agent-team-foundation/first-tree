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

describe("skill eval selection", () => {
  it("selects write floor, gate, and quality for write skill changes", () => {
    const summary = selectSkillEvalRecommendations(["skills/first-tree-write/SKILL.md"], "main");

    expect(summary.recommendations.map((recommendation) => recommendation.command)).toEqual([
      "pnpm --filter @first-tree/skill-evals eval:floor -- --suite first-tree-write",
      "pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-write",
      "pnpm --filter @first-tree/skill-evals eval:quality -- --suite first-tree-write",
    ]);
  });

  it("selects read floor and unified gate for read suite changes", () => {
    const summary = selectSkillEvalRecommendations(["skills/first-tree-read/SKILL.md"]);

    expect(summary.recommendations.map((recommendation) => recommendation.command)).toEqual([
      "pnpm --filter @first-tree/skill-evals eval:floor -- --suite first-tree-read",
      "pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-read",
    ]);
  });

  it("selects seed floor, gate, and quality for seed skill changes", () => {
    const summary = selectSkillEvalRecommendations(["skills/first-tree-seed/SKILL.md"]);

    expect(summary.recommendations.map((recommendation) => recommendation.command)).toEqual([
      "pnpm --filter @first-tree/skill-evals eval:floor -- --suite first-tree-seed",
      "pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-seed",
      "pnpm --filter @first-tree/skill-evals eval:quality -- --suite first-tree-seed",
    ]);
  });

  it("selects all implemented gates and quality when shared judge core changes", () => {
    const summary = selectSkillEvalRecommendations(["packages/skill-evals/src/core/judge/schema.ts"]);

    expect(summary.recommendations.map((recommendation) => recommendation.command)).toEqual([
      "pnpm --filter @first-tree/skill-evals eval:floor",
      "pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-read",
      "pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-write",
      "pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-seed",
      "pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-welcome",
      "pnpm --filter @first-tree/skill-evals eval:gate -- --suite context-tree-review",
      "pnpm --filter @first-tree/skill-evals eval:quality -- --suite first-tree-write",
      "pnpm --filter @first-tree/skill-evals eval:quality -- --suite first-tree-seed",
      "pnpm --filter @first-tree/skill-evals eval:quality -- --suite first-tree-welcome",
    ]);
  });

  it("selects provider-sensitive gate and read periodic coverage for provider runner changes", () => {
    const summary = selectSkillEvalRecommendations(["packages/skill-evals/src/core/provider/claude.ts"]);

    expect(summary.recommendations.map((recommendation) => recommendation.command)).toEqual([
      "pnpm --filter @first-tree/skill-evals eval:floor",
      "pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-read",
      "pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-write",
      "pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-seed",
      "pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-welcome",
      "pnpm --filter @first-tree/skill-evals eval:gate -- --suite context-tree-review",
      "pnpm --filter @first-tree/skill-evals eval:periodic -- --suite first-tree-read",
    ]);
  });

  it("recommends related skill behavior baselines for generated briefing changes", () => {
    const summary = selectSkillEvalRecommendations([
      "packages/client/src/runtime/agent-briefing.ts",
      "packages/client/src/runtime/templates/agent-briefing.ejs",
    ]);

    expect(summary.recommendations).toEqual([
      {
        command: "pnpm --filter @first-tree/skill-evals eval:periodic -- --suite first-tree-read",
        kind: "periodic",
        reason:
          "packages/client/src/runtime/agent-briefing.ts changes generated briefing text; run related skill behavior baseline",
        suite: "first-tree-read",
      },
      {
        command: "pnpm --filter @first-tree/skill-evals eval:gate -- --suite context-tree-review",
        kind: "gate",
        reason:
          "packages/client/src/runtime/agent-briefing.ts changes generated briefing text; run related skill behavior baseline",
        suite: "context-tree-review",
      },
      {
        command: "pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-write",
        kind: "gate",
        reason:
          "packages/client/src/runtime/agent-briefing.ts changes generated briefing text; run related skill behavior baseline",
        suite: "first-tree-write",
      },
    ]);
  });

  it("recommends related skill behavior baselines for generated briefing template changes", () => {
    const summary = selectSkillEvalRecommendations(["packages/client/src/runtime/templates/agent-briefing.ejs"]);

    expect(summary.recommendations).toEqual([
      {
        command: "pnpm --filter @first-tree/skill-evals eval:periodic -- --suite first-tree-read",
        kind: "periodic",
        reason:
          "packages/client/src/runtime/templates/agent-briefing.ejs changes generated briefing text; run related skill behavior baseline",
        suite: "first-tree-read",
      },
      {
        command: "pnpm --filter @first-tree/skill-evals eval:gate -- --suite context-tree-review",
        kind: "gate",
        reason:
          "packages/client/src/runtime/templates/agent-briefing.ejs changes generated briefing text; run related skill behavior baseline",
        suite: "context-tree-review",
      },
      {
        command: "pnpm --filter @first-tree/skill-evals eval:gate -- --suite first-tree-write",
        kind: "gate",
        reason:
          "packages/client/src/runtime/templates/agent-briefing.ejs changes generated briefing text; run related skill behavior baseline",
        suite: "first-tree-write",
      },
    ]);
  });

  it("selects only periodic for shared periodic framework changes", () => {
    const summary = selectSkillEvalRecommendations(["packages/skill-evals/src/core/periodic.ts"]);

    expect(summary.recommendations).toEqual([
      {
        command: "pnpm --filter @first-tree/skill-evals eval:periodic",
        kind: "periodic",
        reason: "packages/skill-evals/src/core/periodic.ts touches periodic eval framework",
        suite: "all",
      },
    ]);
  });

  it("selects suite-scoped periodic for welcome periodic runner changes", () => {
    const summary = selectSkillEvalRecommendations(["packages/skill-evals/src/suites/first-tree-welcome/periodic.ts"]);

    expect(summary.recommendations).toEqual([
      {
        command: "pnpm --filter @first-tree/skill-evals eval:periodic -- --suite first-tree-welcome",
        kind: "periodic",
        reason: "packages/skill-evals/src/suites/first-tree-welcome/periodic.ts touches periodic eval framework",
        suite: "first-tree-welcome",
      },
    ]);
  });

  it("selects suite-scoped periodic for read periodic runner changes", () => {
    const summary = selectSkillEvalRecommendations(["packages/skill-evals/src/suites/first-tree-read/periodic.ts"]);

    expect(summary.recommendations).toEqual([
      {
        command: "pnpm --filter @first-tree/skill-evals eval:periodic -- --suite first-tree-read",
        kind: "periodic",
        reason: "packages/skill-evals/src/suites/first-tree-read/periodic.ts touches periodic eval framework",
        suite: "first-tree-read",
      },
    ]);
  });

  it("selects suite-scoped periodic for seed periodic runner changes", () => {
    const summary = selectSkillEvalRecommendations(["packages/skill-evals/src/suites/first-tree-seed/periodic.ts"]);

    expect(summary.recommendations).toEqual([
      {
        command: "pnpm --filter @first-tree/skill-evals eval:periodic -- --suite first-tree-seed",
        kind: "periodic",
        reason: "packages/skill-evals/src/suites/first-tree-seed/periodic.ts touches periodic eval framework",
        suite: "first-tree-seed",
      },
    ]);
  });

  it("does not recommend live eval for unrelated files", () => {
    const summary = selectSkillEvalRecommendations(["packages/client/src/runtime/agent-slot.ts"]);

    expect(summary.recommendations).toEqual([]);
    expect(summary.notes).toEqual(["No skill-eval-related changes were detected."]);
  });

  it("emits an explicit note (not silence) for a shipped skill intentionally outside skill-evals", () => {
    const summary = selectSkillEvalRecommendations(["skills/first-tree-file-bug/SKILL.md"]);

    expect(summary.recommendations).toEqual([]);
    expect(summary.notes).toEqual([
      "skills/first-tree-file-bug/SKILL.md belongs to first-tree-file-bug, a shipped skill intentionally outside skill-evals (see UNEVALUATED_SHIPPED_SKILLS); no eval selected.",
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
