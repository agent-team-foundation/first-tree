import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIRST_TREE_SEED_SUITE } from "../cases.js";

const validateFloor = FIRST_TREE_SEED_SUITE.validateFloor;
if (!validateFloor) {
  throw new Error("first-tree-seed suite must define validateFloor");
}

const skillMarkdown = readFileSync(join(process.cwd(), "../../skills/first-tree-seed/SKILL.md"), "utf8");

describe("first-tree-seed floor invariants", () => {
  it("accepts the shipped lifecycle cases", () => {
    expect(validateFloor(FIRST_TREE_SEED_SUITE.cases)).toEqual([]);
  });

  it("keeps chat-provided sources independent of GitHub App setup", () => {
    expect(skillMarkdown).toContain("An empty or absent `manifest.sources` is valid");
    expect(skillMarkdown).toMatch(/local\s+project folder or GitHub repository URL/);
    expect(skillMarkdown).toContain("Do not send them to Settings");
    expect(skillMarkdown).toMatch(/rather than asking for the First\s+Tree GitHub App/);
  });

  it("checks same-chat Phase 2 continuation before refusing state C", () => {
    const continuation = skillMarkdown.indexOf("Check for a Phase 2 continuation before classifying state C");
    const stateC = skillMarkdown.indexOf("**C — Already seeded.**");

    expect(continuation).toBeGreaterThan(-1);
    expect(stateC).toBeGreaterThan(continuation);
    expect(skillMarkdown).toContain("this setup chat's visible history");
    expect(skillMarkdown).toContain("re-resolve the same readable sources and enter Phase 2");
  });

  it("delays App coverage guidance until a reviewable milestone", () => {
    expect(skillMarkdown).toContain("After the Phase 1 PR is open");
    expect(skillMarkdown).toContain("do not interrupt source resolution, structure");
    expect(skillMarkdown).toContain("relay only a recovery URL returned");
  });
});
