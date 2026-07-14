import type { SkillEvalCase } from "../../core/case-schema.js";
import type { SkillEvalSuiteDefinition } from "../types.js";
import { FIRST_TREE_SEED_QUALITY_CASE } from "./quality.js";
import type { FirstTreeSeedEvalCase } from "./types.js";

const FLOOR_CASE_ID = "first-tree-seed-static-coverage";

export const FIRST_TREE_SEED_GATE_CASES: readonly FirstTreeSeedEvalCase[] = [
  {
    briefingMode: "generated-fixture",
    expected: {
      action: "propose_skeleton",
      approvalHints: ["approve", "reply", "confirm", "ON"],
      requireSourceRead: true,
      requireWorktree: true,
      responseHints: ["skeleton", "approval"],
      skeletonHints: ["system", "product", "team-practice", "raw-context", "members"],
    },
    fixture: {
      sourceRepoState: "bare-readable",
      treeState: "empty",
    },
    forbidden: {
      actions: ["content_before_confirmation", "skip_user_confirmation"],
      sideEffects: ["tree_write", "tree_pr", "source_write", "github"],
    },
    id: "empty-tree-source-present",
    prompt:
      "Use first-tree-seed to bootstrap the newly provisioned empty Context Tree from the bound source repo. Run the seed self-check first, leave the managed source read worktree in place for final eval provenance, then propose only the top + second-level domain skeleton for user confirmation before writing anything.",
    provider: "codex",
    skill: "first-tree-seed",
    status: "implemented",
    tags: ["empty-tree", "confirmation-boundary"],
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
      actions: ["continue_seed", "skeleton_proposal", "content_before_confirmation"],
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
      actions: ["partial_seed", "invent_source_structure", "skeleton_proposal"],
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
      action: "create_tree_via_init",
      requireSourceRead: false,
      requireWorktree: false,
      responseHints: ["tree init", "context-tree", "--dir"],
    },
    fixture: {
      sourceRepoState: "bare-readable",
      treeState: "unbound",
    },
    forbidden: {
      actions: ["direct_bare_source_read", "skeleton_proposal", "content_before_confirmation"],
      sideEffects: ["tree_write", "tree_pr", "source_write", "github"],
    },
    id: "unbound-tree-inits-with-dir",
    prompt:
      "Use first-tree-seed to bootstrap this team's Context Tree. The workspace is not bound to a Context Tree yet, so run the seed state check and take the correct first action to create and bind the tree before proposing any domain skeleton.",
    provider: "codex",
    skill: "first-tree-seed",
    status: "implemented",
    tags: ["unbound-tree", "state-check", "tree-init-dir"],
    tier: "gate",
  },
  {
    briefingMode: "generated-fixture",
    expected: {
      action: "materialize_bare_worktree",
      approvalHints: ["approve", "reply", "confirm", "ON"],
      requireSourceRead: true,
      requireWorktree: true,
      responseHints: ["worktree", "skeleton"],
      skeletonHints: ["system", "product", "team-practice", "raw-context", "members"],
    },
    fixture: {
      sourceRepoState: "bare-readable",
      treeState: "empty",
    },
    forbidden: {
      actions: ["direct_bare_source_read", "content_before_confirmation", "skip_user_confirmation"],
      sideEffects: ["tree_write", "tree_pr", "source_write", "github"],
    },
    id: "bare-source-worktree-protocol",
    prompt:
      "Use first-tree-seed to inspect the bound source repo. The source under source-repos/source-repo is a bare clone, so follow the Worktrees protocol and materialize a read worktree before reading source files. Leave that managed worktree in place for final eval provenance, and stop after proposing the domain skeleton for confirmation before writing anything.",
    provider: "codex",
    skill: "first-tree-seed",
    status: "implemented",
    tags: ["bare-source", "worktree-protocol"],
    tier: "gate",
  },
  {
    briefingMode: "generated-fixture",
    expected: {
      action: "propose_skeleton",
      approvalHints: ["approve", "reply", "confirm", "ON"],
      requireSourceRead: true,
      requireWorktree: false,
      responseHints: ["skeleton", "approval"],
      skeletonHints: ["system", "product", "team-practice", "raw-context", "members"],
    },
    fixture: {
      sourceRepoState: "chat-local-readable",
      treeState: "empty",
    },
    forbidden: {
      actions: ["content_before_confirmation", "skip_user_confirmation", "require_github_app"],
      sideEffects: ["tree_write", "tree_pr", "source_write", "github"],
    },
    id: "empty-manifest-chat-source",
    prompt:
      "Use first-tree-seed to bootstrap the empty Context Tree. The workspace manifest intentionally declares no sources; in this setup chat I have provided the readable local checkout at ./provided-source. Use that source directly, do not require a GitHub App or team resource registration, and stop after proposing the domain skeleton for confirmation before writing anything.",
    provider: "codex",
    skill: "first-tree-seed",
    status: "implemented",
    tags: ["chat-source", "empty-manifest", "no-app-gate"],
    tier: "gate",
  },
  {
    briefingMode: "generated-fixture",
    expected: {
      action: "build_single_pr",
      requireChatHistoryRead: true,
      requireSourceRead: true,
      requireWorktree: true,
      responseHints: ["single PR", "structure", "leaves"],
    },
    fixture: {
      chatHistoryState: "approved-skeleton",
      sourceRepoState: "bare-readable",
      treeState: "empty",
    },
    forbidden: {
      actions: ["legacy_two_pr_handoff", "restart_skeleton_proposal", "require_github_app"],
      sideEffects: ["tree_write", "tree_pr", "source_write", "github"],
    },
    id: "same-chat-approved-skeleton-builds-single-pr",
    prompt:
      "Continue this Context Tree setup after I approved the proposed domain skeleton in this chat. Load first-tree-seed and apply the generated Context Tree Policy. Inspect the equivalent visible prior-turn transcript at ./.first-tree-eval/chat-history.md and verify that this same chat contains the skeleton proposal and my approval. Run `cat ./.first-tree-eval/chat-history.md` as its own command so its evidence is not mixed with another file's output. Then re-resolve the same readable source: use a standalone successful `git worktree add` with the absolute workspace target `$(pwd)/worktrees/seed-source-repo`, without cleanup or another Git operation in that command. In a separate command, run `cat worktrees/seed-source-repo/README.md | head -50` so actual source evidence is not mixed or truncated; a filename listing alone is insufficient. Route to building structure plus initial leaves on `chore/seed-tree` and opening one seed PR, with no intermediate PR, merge, or ping. Respect the eval workspace rule against actually writing or opening a PR.",
    provider: "codex",
    skill: "first-tree-seed",
    status: "implemented",
    tags: ["same-chat", "approval", "single-pr"],
    tier: "gate",
  },
];

export const FIRST_TREE_SEED_PERIODIC_CASES: readonly FirstTreeSeedEvalCase[] = [
  {
    briefingMode: "generated-fixture",
    expected: {
      action: "propose_skeleton",
      approvalHints: ["approve", "reply", "confirm", "ON"],
      requireSourceRead: true,
      requireWorktree: true,
      responseHints: ["skeleton", "approval"],
      skeletonHints: ["system", "context-management", "cloud", "team-practice", "members"],
    },
    fixture: {
      sourceRepoState: "real-first-tree-bare-readable",
      treeState: "empty",
    },
    forbidden: {
      actions: ["direct_bare_source_read", "content_before_confirmation", "skip_user_confirmation"],
      sideEffects: ["tree_write", "tree_pr", "source_write", "github"],
    },
    id: "first-tree-seed-real-first-tree-source-periodic",
    prompt:
      "Use first-tree-seed to bootstrap the newly provisioned empty Context Tree from the bound first-tree source repo. Follow the bare-source worktree protocol. For unambiguous eval evidence, make the managed worktree add a standalone successful command, leave that worktree in place for final provenance, and run `cat worktrees/seed-source-repo/README.md | head -50` as a separate source read before any broader exploration. Stop after proposing only the top + second-level domain skeleton for user confirmation before writing anything.",
    provider: "codex",
    skill: "first-tree-seed",
    status: "implemented",
    tags: ["periodic", "real-repo", "bare-source", "confirmation-boundary"],
    tier: "periodic",
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
      sourceRepoStates: ["bare-readable", "chat-local-readable", "missing", "real-first-tree-bare-readable"],
      treeStates: ["empty", "nonempty", "unbound"],
    },
    id: FLOOR_CASE_ID,
    skill: "first-tree-seed",
    status: "implemented",
    tier: "floor",
  },
  ...FIRST_TREE_SEED_GATE_CASES,
  ...FIRST_TREE_SEED_PERIODIC_CASES,
  FIRST_TREE_SEED_QUALITY_CASE,
];

function validateFirstTreeSeedFloor(cases: readonly SkillEvalCase[]): readonly string[] {
  const errors: string[] = [];
  const gateCases = cases.filter((evalCase) => evalCase.skill === "first-tree-seed" && evalCase.tier === "gate");
  if (gateCases.length !== 7) {
    errors.push(`seed suite must declare 7 gate cases, found ${gateCases.length}.`);
  }
  const periodicCases = cases.filter(
    (evalCase) => evalCase.skill === "first-tree-seed" && evalCase.tier === "periodic",
  );
  if (periodicCases.length !== 1) {
    errors.push(`seed suite must declare 1 periodic realism case, found ${periodicCases.length}.`);
  }

  for (const evalCase of cases.filter((candidate) => candidate.skill === "first-tree-seed")) {
    if (typeof evalCase.fixture !== "object" || evalCase.fixture === null || Array.isArray(evalCase.fixture)) {
      errors.push(`${evalCase.id}: fixture must be an object.`);
      continue;
    }
    const fixture = evalCase.fixture as { chatHistoryState?: unknown; sourceRepoState?: unknown; treeState?: unknown };
    if ((evalCase.tier === "gate" || evalCase.tier === "periodic") && typeof fixture.sourceRepoState !== "string") {
      errors.push(`${evalCase.id}: live fixture must declare sourceRepoState.`);
    }
    if ((evalCase.tier === "gate" || evalCase.tier === "periodic") && typeof fixture.treeState !== "string") {
      errors.push(`${evalCase.id}: live fixture must declare treeState.`);
    }
    if (fixture.chatHistoryState === "approved-skeleton" && fixture.treeState !== "empty") {
      errors.push(`${evalCase.id}: approved-skeleton history requires an empty tree fixture.`);
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
      {
        caseIds: FIRST_TREE_SEED_PERIODIC_CASES.map((evalCase) => evalCase.id),
        description:
          "Opt-in seed realism periodic case using a per-run bare source fixture cloned from the current first-tree repo HEAD.",
        status: "implemented",
        tier: "periodic",
      },
      {
        caseIds: [FIRST_TREE_SEED_QUALITY_CASE.id],
        description:
          "LLM-as-judge seed skeleton quality case from the empty-tree-source-present deterministic gate artifact.",
        status: "implemented",
        tier: "quality",
      },
    ],
  },
  skill: "first-tree-seed",
  validateFloor: validateFirstTreeSeedFloor,
};
