import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createRunPaths } from "../../../core/paths.js";
import { createEvalReporter } from "../../../core/reporter.js";
import { FIRST_TREE_READ_PERIODIC_CASES } from "../cases.js";
import { setupFixture } from "../fixture.js";
import { findFirstTreeReadPeriodicCase } from "../periodic.js";

describe("first-tree-read periodic cases", () => {
  it("declares the runtime-generated briefing case as the only implemented periodic row", () => {
    expect(FIRST_TREE_READ_PERIODIC_CASES.map((evalCase) => evalCase.id)).toEqual([
      "first-tree-read-runtime-generated-briefing-periodic",
    ]);
    expect(FIRST_TREE_READ_PERIODIC_CASES[0]?.briefingMode).toBe("runtime-generated");
    expect(FIRST_TREE_READ_PERIODIC_CASES[0]?.workspaceKind).toBe("context-tree");
  });

  it("finds the runtime-generated periodic case by id", () => {
    expect(findFirstTreeReadPeriodicCase("first-tree-read-runtime-generated-briefing-periodic")?.briefingMode).toBe(
      "runtime-generated",
    );
    expect(findFirstTreeReadPeriodicCase("missing-periodic-case")).toBeNull();
  });

  it("builds a runtime-generated briefing fixture with First Tree family skills", () => {
    const evalCase = findFirstTreeReadPeriodicCase("first-tree-read-runtime-generated-briefing-periodic");
    if (evalCase === null) throw new Error("missing read runtime-generated periodic case");

    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const paths = createRunPaths({
      caseId: "read-runtime-generated-briefing-fixture-test",
      packageRoot,
      startedAt: new Date().toISOString(),
    });

    try {
      setupFixture(evalCase, paths, createEvalReporter(evalCase.id, false));

      const agentsPath = join(paths.workspacePath, "AGENTS.md");
      const claudePath = join(paths.workspacePath, "CLAUDE.md");
      const briefing = readFileSync(agentsPath, "utf8");

      expect(briefing).toContain("first-tree:generated");
      expect(briefing).toContain("# Working in First Tree");
      expect(briefing).toContain("# Context Tree");
      expect(briefing).toContain("# Skills");
      expect(briefing).toContain("first-tree-read");
      expect(briefing).toContain("first-tree-seed");
      expect(briefing).toContain("first-tree-welcome");
      expect(briefing).toContain("first-tree-write");
      expect(briefing).toContain("first-tree-file-bug");
      expect(briefing).not.toContain("first-tree-gitlab");
      expect(existsSync(join(paths.workspacePath, ".first-tree-workspace", "identity.json"))).toBe(true);
      expect(lstatSync(claudePath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(claudePath)).toBe("AGENTS.md");

      for (const skill of [
        "first-tree-welcome",
        "first-tree-read",
        "first-tree-seed",
        "first-tree-write",
        "first-tree-file-bug",
      ]) {
        expect(existsSync(join(paths.workspacePath, ".agents", "skills", skill, "SKILL.md"))).toBe(true);
        expect(lstatSync(join(paths.workspacePath, ".claude", "skills", skill)).isSymbolicLink()).toBe(true);
      }
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });
});
