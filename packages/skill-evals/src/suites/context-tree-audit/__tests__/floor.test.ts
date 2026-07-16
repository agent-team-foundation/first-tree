import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CONTEXT_TREE_AUDIT_GATE_CASES, CONTEXT_TREE_AUDIT_SUITE } from "../cases.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..");

describe("context-tree-audit static contract", () => {
  it("inherits generated content policy without duplicating content-class paths", () => {
    const skill = readFileSync(join(repoRoot, "skills", "context-tree-audit", "SKILL.md"), "utf8");
    expect(skill).toContain("only content-policy and authority baseline");
    expect(skill).toContain("stored normal content");
    expect(skill).not.toContain("raw-context/");
    expect(skill).not.toContain("members/");
    expect(skill).not.toContain("first-tree tree audit");
    expect(skill).toContain("mechanical or strong semantic finding");
    expect(skill).toContain("tree tree --no-pull");
    const writeSkill = readFileSync(join(repoRoot, "skills", "first-tree-write", "SKILL.md"), "utf8");
    expect(writeSkill).toContain("Before any target");
    expect(writeSkill).toContain("audited HEAD");
  });

  it("keeps the floor linked to every deterministic gate scenario", () => {
    expect(CONTEXT_TREE_AUDIT_GATE_CASES).toHaveLength(7);
    expect(
      CONTEXT_TREE_AUDIT_GATE_CASES.find((item) => item.fixture.scenario === "mechanical")?.expected,
    ).toMatchObject({
      writeSkillRequired: true,
    });
    expect(CONTEXT_TREE_AUDIT_GATE_CASES.some((item) => item.fixture.scenario === "stale-before-write")).toBe(true);
    expect(CONTEXT_TREE_AUDIT_SUITE.coverage.tiers.flatMap((tier) => tier.caseIds)).toEqual([
      "context-tree-audit-static-coverage",
      ...CONTEXT_TREE_AUDIT_GATE_CASES.map((item) => item.id),
    ]);
  });
});
