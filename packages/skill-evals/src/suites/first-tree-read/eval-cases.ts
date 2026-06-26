import type { SkillEvalCase } from "../../core/case-schema.js";
import type { SkillEvalSuiteDefinition } from "../types.js";
import { FIRST_TREE_READ_CASES } from "./cases.js";

const FLOOR_CASE_ID = "first-tree-read-fixture-validation";

export const FIRST_TREE_READ_EVAL_CASES: readonly SkillEvalCase[] = [
  {
    briefingMode: "minimal",
    expected: {
      command: "validate:first-tree-read-fixtures",
      hardOracle: [
        "skill file read",
        "first-tree tree tree --help",
        "selector success",
        "expected facts",
        "non-trigger no first-tree usage",
      ],
    },
    fixture: {
      caseIds: FIRST_TREE_READ_CASES.map((evalCase) => evalCase.id),
      workspaceKinds: ["blank", "context-tree"],
    },
    id: FLOOR_CASE_ID,
    skill: "first-tree-read",
    status: "implemented",
    tier: "floor",
  },
  ...FIRST_TREE_READ_CASES.map(
    (evalCase): SkillEvalCase => ({
      briefingMode: "minimal",
      expected: {
        expectedFacts: evalCase.expectedFacts,
        expectedTrigger: evalCase.expectedTrigger,
      },
      fixture: {
        workspaceKind: evalCase.workspaceKind,
      },
      id: evalCase.id,
      prompt: evalCase.prompt,
      provider: "codex",
      skill: "first-tree-read",
      status: "implemented",
      tags: evalCase.expectedTrigger ? ["trigger"] : ["non-trigger"],
      tier: "gate",
    }),
  ),
];

function validateFirstTreeReadFloor(cases: readonly SkillEvalCase[]): readonly string[] {
  const errors: string[] = [];
  const floor = cases.find((evalCase) => evalCase.id === FLOOR_CASE_ID);
  if (!floor || typeof floor.fixture !== "object" || floor.fixture === null || Array.isArray(floor.fixture)) {
    return [`${FLOOR_CASE_ID}: missing fixture object.`];
  }

  const fixture = floor.fixture as { caseIds?: unknown; workspaceKinds?: unknown };
  if (!Array.isArray(fixture.caseIds) || fixture.caseIds.length !== FIRST_TREE_READ_CASES.length) {
    errors.push(`${FLOOR_CASE_ID}: fixture must list all first-tree-read case ids.`);
  }
  if (!Array.isArray(fixture.workspaceKinds) || !fixture.workspaceKinds.includes("context-tree")) {
    errors.push(`${FLOOR_CASE_ID}: fixture must include context-tree workspace kind.`);
  }

  return errors;
}

export const FIRST_TREE_READ_SUITE: SkillEvalSuiteDefinition = {
  cases: FIRST_TREE_READ_EVAL_CASES,
  coverage: {
    skill: "first-tree-read",
    tiers: [
      {
        caseIds: [FLOOR_CASE_ID],
        description: "Validate skill file and existing read fixture coverage without model calls.",
        status: "implemented",
        tier: "floor",
      },
      {
        caseIds: FIRST_TREE_READ_CASES.map((evalCase) => evalCase.id),
        description: "Run the existing three live read cases through the migrated suite.",
        status: "implemented",
        tier: "gate",
      },
    ],
  },
  skill: "first-tree-read",
  validateFloor: validateFirstTreeReadFloor,
};
