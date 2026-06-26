import type { SkillEvalCase } from "../../core/case-schema.js";
import type { SkillEvalSuiteDefinition } from "../types.js";

const FLOOR_CASE_ID = "first-tree-seed-static-coverage";

const GATE_CASES: readonly SkillEvalCase[] = [
  {
    briefingMode: "generated-fixture",
    expected: {
      action: "write_phase1_skeleton",
      phase: "phase1",
    },
    fixture: {
      sourceRepoState: "bare-readable",
      treeState: "empty",
    },
    forbidden: {
      sideEffects: ["phase2_leaf_content_before_approval"],
    },
    id: "first-tree-seed-empty-tree-phase1",
    prompt: "Bootstrap the newly provisioned empty Context Tree.",
    skill: "first-tree-seed",
    status: "planned",
    tags: ["empty-tree", "phase-boundary"],
    tier: "gate",
  },
  {
    briefingMode: "generated-fixture",
    expected: {
      action: "refuse_nonempty_tree",
      treeDiff: "none",
    },
    fixture: {
      sourceRepoState: "bare-readable",
      treeState: "nonempty",
    },
    forbidden: {
      sideEffects: ["tree_seed", "tree_pr"],
    },
    id: "first-tree-seed-nonempty-refuses",
    prompt: "Seed this Context Tree.",
    skill: "first-tree-seed",
    status: "planned",
    tags: ["lifecycle-boundary"],
    tier: "gate",
  },
  {
    briefingMode: "generated-fixture",
    expected: {
      action: "report_missing_source",
      treeDiff: "none",
    },
    fixture: {
      sourceRepoState: "missing",
      treeState: "empty",
    },
    forbidden: {
      sideEffects: ["tree_seed", "tree_pr"],
    },
    id: "first-tree-seed-missing-source-refuses",
    prompt: "Bootstrap the new Context Tree from the bound source repository.",
    skill: "first-tree-seed",
    status: "planned",
    tags: ["source-boundary"],
    tier: "gate",
  },
];

export const FIRST_TREE_SEED_EVAL_CASES: readonly SkillEvalCase[] = [
  {
    briefingMode: "generated-fixture",
    expected: {
      gateCaseIds: GATE_CASES.map((evalCase) => evalCase.id),
      validator: "case schema and lifecycle fixture shape",
    },
    fixture: {
      sourceRepoStates: ["bare-readable", "missing"],
      treeStates: ["empty", "nonempty"],
    },
    id: FLOOR_CASE_ID,
    skill: "first-tree-seed",
    status: "implemented",
    tier: "floor",
  },
  ...GATE_CASES,
];

function validateFirstTreeSeedFloor(cases: readonly SkillEvalCase[]): readonly string[] {
  const errors: string[] = [];
  for (const evalCase of cases.filter((candidate) => candidate.skill === "first-tree-seed")) {
    if (typeof evalCase.fixture !== "object" || evalCase.fixture === null || Array.isArray(evalCase.fixture)) {
      errors.push(`${evalCase.id}: fixture must be an object.`);
      continue;
    }
    const fixture = evalCase.fixture as { sourceRepoState?: unknown; treeState?: unknown };
    if (evalCase.tier === "gate" && typeof fixture.sourceRepoState !== "string") {
      errors.push(`${evalCase.id}: gate fixture must declare sourceRepoState.`);
    }
    if (evalCase.tier === "gate" && typeof fixture.treeState !== "string") {
      errors.push(`${evalCase.id}: gate fixture must declare treeState.`);
    }
  }
  return errors;
}

export const FIRST_TREE_SEED_SUITE: SkillEvalSuiteDefinition = {
  cases: FIRST_TREE_SEED_EVAL_CASES,
  coverage: {
    skill: "first-tree-seed",
    tiers: [
      {
        caseIds: [FLOOR_CASE_ID],
        description: "Validate seed suite case schema and empty/nonempty source fixture shape.",
        status: "implemented",
        tier: "floor",
      },
      {
        caseIds: GATE_CASES.map((evalCase) => evalCase.id),
        description: "Planned lifecycle, source, and phase-boundary live gate cases.",
        status: "planned",
        tier: "gate",
      },
    ],
  },
  skill: "first-tree-seed",
  validateFloor: validateFirstTreeSeedFloor,
};
