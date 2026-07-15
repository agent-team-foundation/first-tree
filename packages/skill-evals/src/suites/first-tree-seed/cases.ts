import type { SkillEvalCase } from "../../core/case-schema.js";
import type { SkillEvalSuiteDefinition } from "../types.js";
import { FIRST_TREE_SEED_QUALITY_CASE } from "./quality.js";
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
      "Use first-tree-seed to bootstrap the newly provisioned empty Context Tree from the bound source repo. Run the seed self-check first, leave the managed source read worktree in place for final eval provenance, then propose only the Phase 1 top + second-level skeleton for user approval.",
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
      actions: ["direct_bare_source_read", "phase1_skeleton", "phase2_leaf_content_before_approval"],
      sideEffects: ["tree_write", "tree_pr", "source_write", "github"],
    },
    id: "unbound-tree-inits-with-dir",
    prompt:
      "Use first-tree-seed to bootstrap this team's Context Tree. The workspace is not bound to a Context Tree yet, so run the seed state check and take the correct first action to create and bind the tree before any Phase 1 skeleton.",
    provider: "codex",
    skill: "first-tree-seed",
    status: "implemented",
    tags: ["unbound-tree", "state-check", "tree-init-dir"],
    tier: "gate",
  },
  {
    briefingMode: "generated-fixture",
    expected: {
      action: "create_tree_via_init",
      requireGithubGovernanceBootstrap: true,
      requireSourceRead: false,
      requireWorktree: false,
      responseHints: ["tree init", "CODEOWNERS", "ruleset"],
    },
    fixture: {
      sourceRepoState: "bare-readable",
      treeState: "unbound",
    },
    forbidden: {
      actions: ["direct_bare_source_read", "phase1_skeleton", "phase2_leaf_content_before_approval"],
      sideEffects: ["tree_write", "tree_pr", "source_write"],
    },
    id: "unbound-github-tree-governance-bootstrap",
    prompt:
      "Use first-tree-seed to bootstrap this team's newly created GitHub Context Tree. The workspace is not bound yet, so run the state check, create and bind the tree with tree init --dir context-tree, then configure GitHub governance for the newly created Context Repo. Resolve a satisfiable non-author Code Owner, write and push CODEOWNERS, validate it on GitHub, then create or update the repository-local default-branch ruleset. Do not proceed to Phase 1 skeleton work in this gate.",
    provider: "codex",
    skill: "first-tree-seed",
    status: "implemented",
    tags: ["unbound-tree", "github-governance", "codeowners"],
    tier: "gate",
  },
  {
    briefingMode: "generated-fixture",
    expected: {
      action: "create_tree_via_init",
      requireGithubGovernanceRecovery: true,
      requireSourceRead: false,
      requireWorktree: false,
      responseHints: ["tree init", "CODEOWNERS", "ruleset"],
    },
    fixture: {
      sourceRepoState: "bare-readable",
      treeState: "unbound",
    },
    forbidden: {
      actions: ["direct_bare_source_read", "phase1_skeleton", "phase2_leaf_content_before_approval"],
      sideEffects: ["tree_write", "tree_pr", "source_write"],
    },
    id: "unbound-github-governance-fail-closed",
    prompt:
      "Use first-tree-seed to bootstrap this team's newly created GitHub Context Tree. The workspace is not bound yet, so run tree init --dir context-tree. If GitHub governance setup cannot resolve or validate a satisfiable non-author Code Owner, fail closed: do not enable require_code_owner_review or POST/PUT the ruleset, continue the seed flow, and tell the user the manual CODEOWNERS plus branch-rules recovery checklist.",
    provider: "codex",
    skill: "first-tree-seed",
    status: "implemented",
    tags: ["unbound-tree", "github-governance", "fail-closed"],
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
      "Use first-tree-seed to inspect the bound source repo. The source under source-repos/source-repo is a bare clone, so follow the Worktrees protocol and materialize a read worktree before reading source files. Leave that managed worktree in place for final eval provenance, and stop after proposing the Phase 1 skeleton for approval.",
    provider: "codex",
    skill: "first-tree-seed",
    status: "implemented",
    tags: ["bare-source", "worktree-protocol"],
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
      sourceDeclaredRef: "trunk",
      sourceDefaultBranch: "trunk",
      sourceForge: "gitlab",
      sourceLocalBranchState: "stale",
      sourceRepoState: "bare-readable",
      treeState: "empty",
    },
    forbidden: {
      actions: ["direct_bare_source_read", "phase2_leaf_content_before_approval", "skip_user_confirmation"],
      sideEffects: ["tree_write", "tree_pr", "source_write", "github"],
    },
    id: "gitlab-non-main-source-worktree-protocol",
    prompt:
      "Use first-tree-seed to inspect the bound GitLab source repo. The source under source-repos/source-repo is a bare clone whose runtime declaration pins ref=trunk. The local trunk branch is intentionally stale while origin/trunk is current, so follow the Worktrees protocol without hard-coding origin/main or using the stale local branch. Leave that managed worktree in place for final eval provenance, and stop after proposing the Phase 1 skeleton for approval.",
    provider: "codex",
    skill: "first-tree-seed",
    status: "implemented",
    tags: ["gitlab", "bare-source", "declared-ref", "non-main-default", "stale-local", "worktree-protocol"],
    tier: "gate",
  },
  {
    briefingMode: "generated-fixture",
    expected: {
      action: "propose_phase1_skeleton",
      approvalHints: ["approve", "reply", "confirm", "ON"],
      requireSourceRead: true,
      requireWorktree: false,
      responseHints: ["Phase 1", "skeleton", "approval"],
      skeletonHints: ["system", "product", "team-practice", "raw-context", "members"],
    },
    fixture: {
      sourceRepoState: "chat-local-readable",
      treeState: "empty",
    },
    forbidden: {
      actions: ["phase2_leaf_content_before_approval", "skip_user_confirmation", "require_github_app"],
      sideEffects: ["tree_write", "tree_pr", "source_write", "github"],
    },
    id: "empty-manifest-chat-source",
    prompt:
      "Use first-tree-seed to bootstrap the empty Context Tree. The workspace manifest intentionally declares no sources; in this setup chat I have provided the readable local checkout at ./provided-source. Use that source directly, do not require a GitHub App or team resource registration, and stop after the Phase 1 skeleton proposal for approval.",
    provider: "codex",
    skill: "first-tree-seed",
    status: "implemented",
    tags: ["chat-source", "empty-manifest", "no-app-gate"],
    tier: "gate",
  },
  {
    briefingMode: "generated-fixture",
    expected: {
      action: "continue_phase2",
      requireChatHistoryRead: true,
      requireSourceRead: true,
      requireWorktree: true,
      responseHints: ["Phase 2", "leaf"],
    },
    fixture: {
      chatHistoryState: "approved-phase1",
      sourceRepoState: "bare-readable",
      treeState: "phase1-approved",
    },
    forbidden: {
      actions: ["refuse_nonempty_tree", "restart_phase1", "require_github_app"],
      sideEffects: ["tree_pr", "source_write", "github"],
    },
    id: "same-chat-phase2-continuation",
    prompt:
      "Continue this Context Tree setup after I merged the Phase 1 PR. Load first-tree-seed and apply the generated Context Tree Policy. Before deciding whether the populated-tree exception applies, inspect the equivalent visible prior-turn transcript at ./.first-tree-eval/chat-history.md and verify that this same chat contains the Phase 1 proposal, my approval, and the PR handoff. Run `cat ./.first-tree-eval/chat-history.md` as its own command so its evidence is not mixed with another file's output. Then re-resolve the same readable source: use a standalone successful `git worktree add` with the absolute workspace target `$(pwd)/worktrees/seed-source-repo`, without cleanup or another Git operation in that command. In a separate command, run `cat worktrees/seed-source-repo/README.md | head -50` so actual source evidence is not mixed or truncated; a filename listing alone is insufficient. Route to Phase 2 leaf drafting only after those checks. Respect the eval workspace rule against actually writing or opening a PR.",
    provider: "codex",
    skill: "first-tree-seed",
    status: "implemented",
    tags: ["same-chat", "phase2", "continuation"],
    tier: "gate",
  },
  {
    briefingMode: "generated-fixture",
    expected: {
      action: "refuse_nonempty_tree",
      requireSourceRead: false,
      requireWorktree: false,
      responseHints: ["history", "populated", "first-tree-write", "focused maintenance", "cannot continue"],
    },
    fixture: {
      chatHistoryState: "absent",
      sourceRepoState: "bare-readable",
      treeState: "phase1-approved",
    },
    forbidden: {
      actions: ["continue_phase2", "continue_seed", "phase1_skeleton"],
      sideEffects: ["tree_write", "tree_pr", "source_write", "github"],
    },
    id: "phase1-shaped-tree-without-same-chat-history-refuses",
    prompt:
      "I claim the Phase 1 skeleton is merged and ask you to continue, but this chat has no visible prior proposal, approval, or PR-handoff transcript. Use first-tree-seed to classify the populated tree: read the workspace manifest for the state check, but do not treat the tree shape or my current-message claim as same-chat authorization. Do not explore source or write anything.",
    provider: "codex",
    skill: "first-tree-seed",
    status: "implemented",
    tags: ["same-chat", "phase2", "missing-history", "negative"],
    tier: "gate",
  },
];

export const FIRST_TREE_SEED_PERIODIC_CASES: readonly FirstTreeSeedEvalCase[] = [
  {
    briefingMode: "generated-fixture",
    expected: {
      action: "propose_phase1_skeleton",
      approvalHints: ["approve", "reply", "confirm", "ON"],
      requireSourceRead: true,
      requireWorktree: true,
      responseHints: ["Phase 1", "skeleton", "approval"],
      skeletonHints: ["system", "context-management", "cloud", "team-practice", "members"],
    },
    fixture: {
      sourceRepoState: "real-first-tree-bare-readable",
      treeState: "empty",
    },
    forbidden: {
      actions: ["direct_bare_source_read", "phase2_leaf_content_before_approval", "skip_user_confirmation"],
      sideEffects: ["tree_write", "tree_pr", "source_write", "github"],
    },
    id: "first-tree-seed-real-first-tree-source-periodic",
    prompt:
      "Use first-tree-seed to bootstrap the newly provisioned empty Context Tree from the bound first-tree source repo. Follow the bare-source worktree protocol. For unambiguous eval evidence, make the managed worktree add a standalone successful command, leave that worktree in place for final provenance, and run `cat worktrees/seed-source-repo/README.md | head -50` as a separate source read before any broader exploration. Stop after proposing only the Phase 1 top + second-level skeleton for user approval.",
    provider: "codex",
    skill: "first-tree-seed",
    status: "implemented",
    tags: ["periodic", "real-repo", "bare-source", "phase-boundary"],
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
      treeStates: ["empty", "nonempty", "phase1-approved", "unbound"],
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
  if (gateCases.length !== 11) {
    errors.push(`seed suite must declare 11 gate cases, found ${gateCases.length}.`);
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
    if (fixture.treeState === "phase1-approved" && typeof fixture.chatHistoryState !== "string") {
      errors.push(`${evalCase.id}: phase1-approved fixture must declare chatHistoryState.`);
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
        description:
          "Implemented seed lifecycle, source, GitHub governance, and bare-worktree protocol live gate cases.",
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
