import type { SkillEvalCase } from "../../core/case-schema.js";
import type { SkillEvalSuiteDefinition } from "../types.js";

const FLOOR_CASE_ID = "first-tree-write-static-coverage";

const GATE_CASES: readonly SkillEvalCase[] = [
  {
    briefingMode: "minimal",
    expected: {
      action: "refuse_without_source",
      treeDiff: "none",
    },
    fixture: {
      sourceArtifact: "absent",
      treeState: "populated",
    },
    forbidden: {
      sideEffects: ["tree_write", "tree_pr"],
    },
    id: "first-tree-write-no-source-refuses",
    prompt: "Update the Context Tree with the latest architecture decision.",
    skill: "first-tree-write",
    status: "planned",
    tags: ["source-boundary"],
    tier: "gate",
  },
  {
    briefingMode: "minimal",
    expected: {
      action: "write_minimal_tree_diff",
      verify: true,
    },
    fixture: {
      sourceArtifact: "durable-decision-note",
      treeState: "populated",
    },
    forbidden: {
      content: ["PR id", "implementation detail", "history narration", "## Source"],
    },
    id: "first-tree-write-durable-source-writes",
    prompt: "Reflect this design note into the Context Tree.",
    skill: "first-tree-write",
    status: "planned",
    tags: ["tree-diff", "verify"],
    tier: "gate",
  },
  {
    briefingMode: "minimal",
    expected: {
      action: "refuse_implementation_only_source",
      treeDiff: "none",
    },
    fixture: {
      sourceArtifact: "implementation-only-diff",
      treeState: "populated",
    },
    forbidden: {
      sideEffects: ["tree_write", "tree_pr"],
    },
    id: "first-tree-write-implementation-only-no-write",
    prompt: "Put this implementation-only diff into the Context Tree.",
    skill: "first-tree-write",
    status: "planned",
    tags: ["source-boundary"],
    tier: "gate",
  },
];

export const FIRST_TREE_WRITE_EVAL_CASES: readonly SkillEvalCase[] = [
  {
    briefingMode: "minimal",
    expected: {
      gateCaseIds: GATE_CASES.map((evalCase) => evalCase.id),
      validator: "case schema and fixture shape",
    },
    fixture: {
      sourceArtifacts: ["absent", "durable-decision-note", "implementation-only-diff"],
      treeStates: ["populated"],
    },
    id: FLOOR_CASE_ID,
    skill: "first-tree-write",
    status: "implemented",
    tier: "floor",
  },
  ...GATE_CASES,
];

function validateFirstTreeWriteFloor(cases: readonly SkillEvalCase[]): readonly string[] {
  const errors: string[] = [];
  for (const evalCase of cases.filter((candidate) => candidate.skill === "first-tree-write")) {
    if (typeof evalCase.fixture !== "object" || evalCase.fixture === null || Array.isArray(evalCase.fixture)) {
      errors.push(`${evalCase.id}: fixture must be an object.`);
      continue;
    }
    const fixture = evalCase.fixture as { sourceArtifact?: unknown; treeState?: unknown };
    if (evalCase.tier === "gate" && typeof fixture.sourceArtifact !== "string") {
      errors.push(`${evalCase.id}: gate fixture must declare sourceArtifact.`);
    }
    if (evalCase.tier === "gate" && typeof fixture.treeState !== "string") {
      errors.push(`${evalCase.id}: gate fixture must declare treeState.`);
    }
  }
  return errors;
}

export const FIRST_TREE_WRITE_SUITE: SkillEvalSuiteDefinition = {
  cases: FIRST_TREE_WRITE_EVAL_CASES,
  coverage: {
    skill: "first-tree-write",
    tiers: [
      {
        caseIds: [FLOOR_CASE_ID],
        description: "Validate write suite case schema and source/tree fixture shape.",
        status: "implemented",
        tier: "floor",
      },
      {
        caseIds: GATE_CASES.map((evalCase) => evalCase.id),
        description: "Planned source-boundary and tree-diff live gate cases.",
        status: "planned",
        tier: "gate",
      },
    ],
  },
  skill: "first-tree-write",
  validateFloor: validateFirstTreeWriteFloor,
};
