import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SkillEvalCase } from "../../../core/case-schema.js";
import { FIRST_TREE_WELCOME_SUITE } from "../cases.js";

// These tests run in `pnpm test` / CI (unlike the model-gated eval:* commands),
// so they are where the welcome matrix's structural invariants are actually
// locked: no orphan implemented action, exactly one catch-all, and unambiguous
// first-match-wins (unique state tuples). They guard against the drift class
// that produced #1341 → #1344.

const validateFloor = FIRST_TREE_WELCOME_SUITE.validateFloor;
if (!validateFloor) {
  throw new Error("first-tree-welcome suite must define validateFloor");
}
const cases = FIRST_TREE_WELCOME_SUITE.cases;
const skillMarkdown = readFileSync(join(process.cwd(), "../../skills/first-tree-welcome/SKILL.md"), "utf8");

function hasTag(evalCase: SkillEvalCase, tag: string): boolean {
  const tags = (evalCase as { tags?: readonly string[] }).tags;
  return Array.isArray(tags) && tags.includes(tag);
}

describe("first-tree-welcome floor invariants", () => {
  it("accepts the shipped matrix with no errors", () => {
    expect(validateFloor(cases)).toEqual([]);
  });

  it("implements periodic coverage for every concrete non-catch-all matrix row", () => {
    const periodicCases = cases.filter((evalCase) => evalCase.tier === "periodic");

    expect(periodicCases).toHaveLength(10);
    expect(periodicCases.every((evalCase) => evalCase.status === "implemented")).toBe(true);
    expect(periodicCases.some((evalCase) => hasTag(evalCase, "catch-all"))).toBe(false);
  });

  it("flags an implemented row whose action has no casePassed branch (orphan)", () => {
    // Deliberately break one implemented row's action; `expected` is the schema's
    // generic `unknown`, so a plain override is type-safe here.
    const broken = cases.map(
      (evalCase): SkillEvalCase =>
        evalCase.tier === "gate" && evalCase.status === "implemented"
          ? { ...evalCase, expected: { ...(evalCase.expected as Record<string, unknown>), action: "made_up_action" } }
          : evalCase,
    );
    expect(validateFloor(broken).some((error) => error.includes("orphan"))).toBe(true);
  });

  it("flags an implemented periodic row whose action has no casePassed branch (orphan)", () => {
    const broken = cases.map(
      (evalCase): SkillEvalCase =>
        evalCase.tier === "periodic" && evalCase.status === "implemented"
          ? { ...evalCase, expected: { ...(evalCase.expected as Record<string, unknown>), action: "made_up_action" } }
          : evalCase,
    );
    expect(validateFloor(broken).some((error) => error.includes("orphan"))).toBe(true);
  });

  it("flags an implemented row whose forbidden action has no detector branch (orphan)", () => {
    const broken = cases.map(
      (evalCase): SkillEvalCase =>
        evalCase.tier === "periodic" && evalCase.status === "implemented"
          ? {
              ...evalCase,
              forbidden: { ...(evalCase.forbidden as Record<string, unknown>), actions: ["made-up-risk"] },
            }
          : evalCase,
    );
    expect(validateFloor(broken).some((error) => error.includes("forbidden action"))).toBe(true);
  });

  it("flags two non-catch-all rows that claim the same state tuple", () => {
    const sample = cases.find((evalCase) => evalCase.tier === "gate" && !hasTag(evalCase, "catch-all"));
    if (!sample) throw new Error("expected at least one non-catch-all gate row");
    // A second row with the same fixture tuple makes first-match-wins ambiguous.
    const duplicate: SkillEvalCase = { ...sample, id: `${sample.id}-dup` };
    expect(validateFloor([...cases, duplicate]).some((error) => error.includes("overlapping state tuple"))).toBe(true);
  });

  it("requires exactly one explicit catch-all row", () => {
    const withoutCatchAll = cases.filter((evalCase) => !hasTag(evalCase, "catch-all"));
    expect(validateFloor(withoutCatchAll).some((error) => error.includes("catch-all"))).toBe(true);
  });

  it("requires the catch-all row to be the last gate row", () => {
    const sample = cases.find((evalCase) => evalCase.tier === "gate" && !hasTag(evalCase, "catch-all"));
    if (!sample) throw new Error("expected at least one non-catch-all gate row");
    // A specific (non-catch-all) row placed AFTER the catch-all would be
    // unreachable under first-match-wins. Give it a unique tuple so only the
    // "must be last" invariant fires, not the uniqueness one.
    const trailing: SkillEvalCase = {
      ...sample,
      id: `${sample.id}-trailing`,
      fixture: {
        ...(sample.fixture as Record<string, unknown>),
        role: "invitee",
        chatScenario: "tree-setup",
        repoState: "local-readable",
        treeState: "empty",
      },
    };
    expect(validateFloor([...cases, trailing]).some((error) => error.includes("must be last"))).toBe(true);
  });

  it("keeps onboarding attribution and no-project first reply guidance aligned with the product flow", () => {
    const description = skillMarkdown.match(/^description:\s*(.*)$/m)?.[1] ?? "";

    expect(description).not.toContain("local project folder path");
    expect(skillMarkdown).toContain("Treat the opening message as the user's onboarding request.");
    expect(skillMarkdown).toContain("local project folder path");
    expect(skillMarkdown).toContain("GitHub repo URL");
    expect(skillMarkdown).not.toContain("First Tree sent it");
  });
});
