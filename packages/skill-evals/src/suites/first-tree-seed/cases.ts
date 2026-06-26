import type { SkillEvalCase } from "../../core/case-schema.js";
import type { SkillEvalSuiteDefinition } from "../types.js";
import type { FirstTreeSeedEvalCase } from "./types.js";

const FLOOR_CASE_ID = "first-tree-seed-static-coverage";

export const FIRST_TREE_SEED_GATE_CASES: readonly FirstTreeSeedEvalCase[] = [
  {
    briefingMode: "generated-fixture",
    expected: {
      action: "propose_phase1_skeleton",
      approvalHints: ["approve", "reply", "confirm", "ON"],
      requireSourceRead: true,
      requireWorktree: true,
      responseHints: ["Phase 1", "skeleton", "approval"],
      skeletonHints: ["system", "product", "team-practice", "raw-context", "members"],
    },
    fixture: {
      sourceRepoState: "bare-readable",
      treeState: "empty",
    },
    forbidden: {
      actions: ["phase2_leaf_content_before_approval", "skip_user_confirmation"],
      sideEffects: ["tree_write", "tree_pr", "source_write", "github"],
    },
    id: "empty-tree-source-present",
    prompt:
      "Use first-tree-seed to bootstrap the newly provisioned empty Context Tree from the bound source repo. Run the seed self-check first, then propose only the Phase 1 top + second-level skeleton for user approval.",
    provider: "codex",
    skill: "first-tree-seed",
    status: "implemented",
    tags: ["empty-tree", "phase-boundary"],
    tier: "gate",
  },
  {
    briefingMode: "generated-fixture",
    expected: {
      action: "refuse_nonempty_tree",
      requireSourceRead: false,
      requireWorktree: false,
      responseHints: ["non-empty", "already", "first-tree-write", "focused maintenance"],
    },
    fixture: {
      sourceRepoState: "bare-readable",
      treeState: "nonempty",
    },
    forbidden: {
      actions: ["continue_seed", "phase1_skeleton", "phase2_leaf_content_before_approval"],
      sideEffects: ["tree_write", "tree_pr", "source_write", "github"],
    },
    id: "non-empty-tree-refuses",
    prompt:
      "Use first-tree-seed to seed this Context Tree. Run the empty-tree self-check before doing any source exploration.",
    provider: "codex",
    skill: "first-tree-seed",
    status: "implemented",
    tags: ["lifecycle-boundary"],
    tier: "gate",
  },
  {
    briefingMode: "generated-fixture",
    expected: {
      action: "report_missing_source",
      requireSourceRead: false,
      requireWorktree: false,
      responseHints: ["missing", "source", "source-repos/source-repo", "provision"],
    },
    fixture: {
      sourceRepoState: "missing",
      treeState: "empty",
    },
    forbidden: {
      actions: ["partial_seed", "invent_source_structure", "phase1_skeleton"],
      sideEffects: ["tree_write", "tree_pr", "source_write", "github"],
    },
    id: "source-missing-refuses",
    prompt:
      "Use first-tree-seed to bootstrap the new Context Tree. The workspace manifest declares a source repo, but the source clone may not be provisioned.",
    provider: "codex",
    skill: "first-tree-seed",
    status: "implemented",
    tags: ["source-boundary"],
    tier: "gate",
  },
  {
    briefingMode: "generated-fixture",
    expected: {
      action: "materialize_bare_worktree",
      approvalHints: ["approve", "reply", "confirm", "ON"],
      requireSourceRead: true,
      requireWorktree: true,
      responseHints: ["worktree", "Phase 1", "skeleton"],
      skeletonHints: ["system", "product", "team-practice", "raw-context", "members"],
    },
    fixture: {
      sourceRepoState: "bare-readable",
      treeState: "empty",
    },
    forbidden: {
      actions: ["direct_bare_source_read", "phase2_leaf_content_before_approval", "skip_user_confirmation"],
      sideEffects: ["tree_write", "tree_pr", "source_write", "github"],
    },
    id: "bare-source-worktree-protocol",
    prompt:
      "Use first-tree-seed to inspect the bound source repo. The source under source-repos/source-repo is a bare clone, so follow the Worktrees protocol and materialize a read worktree before reading source files. Stop after proposing the Phase 1 skeleton for approval.",
    provider: "codex",
    skill: "first-tree-seed",
    status: "implemented",
    tags: ["bare-source", "worktree-protocol"],
    tier: "gate",
  },
];

export const FIRST_TREE_SEED_EVAL_CASES: readonly SkillEvalCase[] = [
  {
    briefingMode: "generated-fixture",
    expected: {
      gateCaseIds: FIRST_TREE_SEED_GATE_CASES.map((evalCase) => evalCase.id),
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
  ...FIRST_TREE_SEED_GATE_CASES,
];

function validateFirstTreeSeedFloor(cases: readonly SkillEvalCase[]): readonly string[] {
  const errors: string[] = [];
  const gateCases = cases.filter((evalCase) => evalCase.skill === "first-tree-seed" && evalCase.tier === "gate");
  if (gateCases.length !== 4) {
    errors.push(`seed suite must declare 4 gate cases, found ${gateCases.length}.`);
  }

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
        caseIds: FIRST_TREE_SEED_GATE_CASES.map((evalCase) => evalCase.id),
        description: "Implemented seed lifecycle, source, and bare-worktree protocol live gate cases.",
        status: "implemented",
        tier: "gate",
      },
    ],
  },
  skill: "first-tree-seed",
  validateFloor: validateFirstTreeSeedFloor,
};
