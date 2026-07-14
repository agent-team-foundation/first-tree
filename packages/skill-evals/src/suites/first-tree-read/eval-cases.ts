import type { SkillEvalCase } from "../../core/case-schema.js";
import type { SkillEvalSuiteDefinition } from "../types.js";
import { FIRST_TREE_READ_CASES, FIRST_TREE_READ_PERIODIC_CASES } from "./cases.js";

const FLOOR_CASE_ID = "first-tree-read-floor-coverage";

export const FIRST_TREE_READ_EVAL_CASES: readonly SkillEvalCase[] = [
  {
    briefingMode: "minimal",
    expected: {
      command: "eval:floor -- --suite first-tree-read",
      hardOracle: ["coverage matrix", "skill file frontmatter", "read case declarations"],
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
  ...FIRST_TREE_READ_PERIODIC_CASES.map(
    (evalCase): SkillEvalCase => ({
      briefingMode: "runtime-generated",
      expected: {
        expectedFacts: evalCase.expectedFacts,
        expectedTrigger: evalCase.expectedTrigger,
        runtimeBoundary: "generated briefing fixture only; not live First Tree Cloud E2E",
      },
      fixture: {
        installedSkills: [
          "first-tree-welcome",
          "first-tree-read",
          "first-tree-seed",
          "first-tree-write",
          "first-tree-file-bug",
          "first-tree-gitlab",
        ],
        workspaceKind: evalCase.workspaceKind,
      },
      id: evalCase.id,
      prompt: evalCase.prompt,
      provider: "codex",
      skill: "first-tree-read",
      status: "implemented",
      tags: ["runtime-generated", "periodic"],
      tier: "periodic",
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
        description: "Validate read skill file metadata and case coverage without model calls.",
        status: "implemented",
        tier: "floor",
      },
      {
        caseIds: FIRST_TREE_READ_CASES.map((evalCase) => evalCase.id),
        description: "Run the existing three live read cases through the migrated suite.",
        status: "implemented",
        tier: "gate",
      },
      {
        caseIds: FIRST_TREE_READ_PERIODIC_CASES.map((evalCase) => evalCase.id),
        description:
          "Run the read trigger against a runtime-generated briefing fixture without live First Tree Cloud E2E.",
        status: "implemented",
        tier: "periodic",
      },
    ],
  },
  skill: "first-tree-read",
  validateFloor: validateFirstTreeReadFloor,
};
