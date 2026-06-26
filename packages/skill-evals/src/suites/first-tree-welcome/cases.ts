import type { SkillEvalCase } from "../../core/case-schema.js";
import type { SkillEvalSuiteDefinition } from "../types.js";

const FLOOR_CASE_ID = "first-tree-welcome-setup-matrix";

const WELCOME_ROWS = [
  {
    action: "route_to_tree_skill",
    id: "first-tree-welcome-tree-kickoff-chat",
    kickoffKind: "tree",
    prompt: "First Tree system kickoff: prepare this workspace tree.",
    repoState: "unknown",
    role: "admin",
    treeState: "unknown",
  },
  {
    action: "invitee_waits_for_team_readiness",
    id: "first-tree-welcome-invitee-not-ready",
    kickoffKind: "intro",
    prompt: "Introduce First Tree to this invited teammate.",
    repoState: "none",
    role: "invitee",
    treeState: "none",
  },
  {
    action: "ask_for_repo_path_or_url",
    id: "first-tree-welcome-no-repo-intro",
    kickoffKind: "intro",
    prompt: "Welcome the user and help them get value from First Tree.",
    repoState: "none",
    role: "admin",
    treeState: "none",
  },
  {
    action: "report_auth_failure_without_claiming_repo_read",
    id: "first-tree-welcome-repo-auth-fails",
    kickoffKind: "intro",
    prompt: "Welcome the user using the selected repository.",
    repoState: "selected-auth-fails",
    role: "admin",
    treeState: "unknown",
  },
  {
    action: "value_first_then_setup_handoff",
    id: "first-tree-welcome-admin-missing-github-app",
    kickoffKind: "intro",
    prompt: "Welcome the admin using local repository evidence.",
    repoState: "local-readable",
    role: "admin",
    treeState: "unknown",
  },
  {
    action: "guide_repo_selection_without_claiming_repo_read",
    id: "first-tree-welcome-app-installed-no-repo-selected",
    kickoffKind: "intro",
    prompt: "Welcome the admin after GitHub App installation.",
    repoState: "none",
    role: "admin",
    treeState: "unknown",
  },
  {
    action: "offer_code_value_without_tree_setup_task",
    id: "first-tree-welcome-readable-repo-empty-tree",
    kickoffKind: "work",
    prompt: "Help the user pick the first valuable task.",
    repoState: "selected-readable",
    role: "admin",
    treeState: "empty",
  },
  {
    action: "offer_bounded_first_tasks_from_repo_and_tree",
    id: "first-tree-welcome-readable-repo-populated-tree",
    kickoffKind: "work",
    prompt: "Use repo and Context Tree evidence to suggest first work.",
    repoState: "selected-readable",
    role: "admin",
    treeState: "populated",
  },
  {
    action: "offer_repo_value_without_claiming_tree_ready",
    id: "first-tree-welcome-readable-repo-tree-unknown",
    kickoffKind: "work",
    prompt: "Use available repo evidence to suggest first work.",
    repoState: "selected-readable",
    role: "admin",
    treeState: "unknown",
  },
] as const;

const GATE_CASES: readonly SkillEvalCase[] = WELCOME_ROWS.map(
  (row): SkillEvalCase => ({
    briefingMode: "generated-fixture",
    expected: {
      action: row.action,
      forbiddenClaims: ["repo read without evidence", "tree ready without evidence"],
    },
    fixture: {
      githubAppState:
        row.id === "first-tree-welcome-admin-missing-github-app"
          ? "missing"
          : row.id === "first-tree-welcome-app-installed-no-repo-selected"
            ? "installed"
            : "unknown",
      kickoffKind: row.kickoffKind,
      repoState: row.repoState,
      role: row.role,
      treeSetupChat: row.kickoffKind === "tree" ? "exists" : "absent",
      treeState: row.treeState,
    },
    forbidden: {
      sideEffects: ["github_auth", "tree_seed", "tree_pr"],
    },
    id: row.id,
    prompt: row.prompt,
    skill: "first-tree-welcome",
    status: "planned",
    tags: ["onboarding-matrix"],
    tier: "gate",
  }),
);

export const FIRST_TREE_WELCOME_EVAL_CASES: readonly SkillEvalCase[] = [
  {
    briefingMode: "generated-fixture",
    expected: {
      matrixRows: WELCOME_ROWS.length,
      validator: "9-row onboarding setup matrix",
    },
    fixture: {
      kickoffKinds: ["intro", "work", "tree"],
      repoStates: ["none", "local-readable", "selected-readable", "selected-auth-fails", "unknown"],
      roles: ["admin", "invitee"],
      treeStates: ["none", "empty", "populated", "unknown"],
    },
    id: FLOOR_CASE_ID,
    skill: "first-tree-welcome",
    status: "implemented",
    tier: "floor",
  },
  ...GATE_CASES,
];

function validateFirstTreeWelcomeFloor(cases: readonly SkillEvalCase[]): readonly string[] {
  const errors: string[] = [];
  const gateRows = cases.filter((evalCase) => evalCase.skill === "first-tree-welcome" && evalCase.tier === "gate");
  if (gateRows.length !== 9) {
    errors.push(`welcome matrix must declare 9 gate rows, found ${gateRows.length}.`);
  }

  for (const evalCase of gateRows) {
    if (typeof evalCase.fixture !== "object" || evalCase.fixture === null || Array.isArray(evalCase.fixture)) {
      errors.push(`${evalCase.id}: fixture must be an object.`);
      continue;
    }
    const fixture = evalCase.fixture as {
      kickoffKind?: unknown;
      repoState?: unknown;
      role?: unknown;
      treeState?: unknown;
    };
    for (const field of ["role", "kickoffKind", "repoState", "treeState"] as const) {
      if (typeof fixture[field] !== "string") {
        errors.push(`${evalCase.id}: fixture must declare ${field}.`);
      }
    }
  }

  return errors;
}

export const FIRST_TREE_WELCOME_SUITE: SkillEvalSuiteDefinition = {
  cases: FIRST_TREE_WELCOME_EVAL_CASES,
  coverage: {
    skill: "first-tree-welcome",
    tiers: [
      {
        caseIds: [FLOOR_CASE_ID],
        description: "Validate the 9-row onboarding setup matrix schema.",
        status: "implemented",
        tier: "floor",
      },
      {
        caseIds: GATE_CASES.map((evalCase) => evalCase.id),
        description: "Planned welcome onboarding matrix live gate rows.",
        status: "planned",
        tier: "gate",
      },
    ],
  },
  skill: "first-tree-welcome",
  validateFloor: validateFirstTreeWelcomeFloor,
};
