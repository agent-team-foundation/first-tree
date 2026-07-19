import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FIRST_TREE_READ_CASES } from "../cases.js";
import { FIRST_TREE_READ_SUITE } from "../eval-cases.js";

const validateFloor = FIRST_TREE_READ_SUITE.validateFloor;
if (!validateFloor) throw new Error("first-tree-read suite must define validateFloor");

const skill = readFileSync(join(process.cwd(), "../../skills/first-tree-read/SKILL.md"), "utf8");

describe("first-tree-read floor contract", () => {
  it("keeps the declared gate matrix complete", () => {
    expect(validateFloor(FIRST_TREE_READ_SUITE.cases)).toEqual([]);
    expect(FIRST_TREE_READ_CASES.map((evalCase) => evalCase.id)).toContain("byo-explicit-team-trigger");
  });

  it("states the fail-closed, exact-snapshot BYO activation boundary", () => {
    expect(skill).toContain("names an explicit First Tree Team id");
    expect(skill).toContain('first-tree --json tree read --team "<team-id>" --snapshot');
    expect(skill).toContain("run exactly\none activation");
    expect(skill).toContain("Authority, binding, fetch, commit, or snapshot failure is fail-closed");
    expect(skill).toContain("Do not run another Server request,\nfetch, pull, clone, or activation");
    expect(skill).toContain("include `--no-pull` on every selector");
    expect(skill).toContain("Never reuse a snapshot across\nTeams or tasks");
  });

  it("preserves the managed-workspace compatibility route", () => {
    expect(skill).toContain("Otherwise retain the **managed workspace** path below");
    expect(skill).toContain("pull-before-selector behavior");
  });
});
