import type { SkillEvalCase } from "../../core/case-schema.js";
import type { SkillEvalSuiteDefinition } from "../types.js";
import { GRADED_ACTIONS, HANDLED_FORBIDDEN_ACTIONS } from "./grader.js";
import { FIRST_TREE_WELCOME_QUALITY_CASE } from "./quality.js";
import type { FirstTreeWelcomeEvalCase, WelcomeExpectedAction } from "./types.js";

const FLOOR_CASE_ID = "first-tree-welcome-setup-matrix";
const IMPLEMENTED_GATE_CASE_IDS = new Set([
  "first-tree-welcome-selected-first-task",
  "first-tree-welcome-tree-kickoff-chat",
  "first-tree-welcome-no-repo-intro",
  "first-tree-welcome-readable-repo-populated-tree",
]);

type WelcomeRow = {
  action: WelcomeExpectedAction;
  bridgeForbiddenHints?: readonly string[];
  bridgeRequiredHints?: readonly string[];
  forbiddenActions: readonly string[];
  forbiddenClaims: readonly string[];
  id: string;
  chatScenario: FirstTreeWelcomeEvalCase["fixture"]["chatScenario"];
  prompt: string;
  repoState: FirstTreeWelcomeEvalCase["fixture"]["repoState"];
  requiredResponseHints: readonly string[];
  role: FirstTreeWelcomeEvalCase["fixture"]["role"];
  tags: readonly string[];
  taskOptionHints?: readonly string[];
  treeState: FirstTreeWelcomeEvalCase["fixture"]["treeState"];
};

const WELCOME_ROWS: readonly WelcomeRow[] = [
  {
    action: "route_to_tree_skill",
    forbiddenActions: ["first-task-options", "seed-tree-in-welcome-chat"],
    forbiddenClaims: ["repo evidence", "tree readiness"],
    id: "first-tree-welcome-tree-kickoff-chat",
    chatScenario: "tree-setup",
    prompt: `This chat sets up team context for future agent work, not the First Tree welcome launcher.

Use first-tree-welcome only to classify the setup state from its matrix. Reply with the correct lane for this chat. Do not offer value-chat first-task options.`,
    repoState: "unknown",
    requiredResponseHints: ["tree setup", "first-tree-seed", "first-tree-read", "first-tree-write"],
    role: "admin",
    tags: ["welcome-row-1", "tree-lane"],
    treeState: "unknown",
  },
  {
    action: "invitee_waits_for_team_readiness",
    forbiddenActions: ["admin-setup", "repo-selection", "duplicate-tree", "setup-as-first-task"],
    forbiddenClaims: ["repo evidence", "tree readiness"],
    id: "first-tree-welcome-invitee-not-ready",
    chatScenario: "team-onboarding",
    prompt: "Introduce First Tree to this invited teammate.",
    repoState: "none",
    requiredResponseHints: ["admin", "local", "path"],
    role: "invitee",
    tags: ["welcome-row-2", "planned"],
    treeState: "none",
  },
  {
    action: "offer_single_select_microtasks",
    forbiddenActions: ["admin-setup", "repo-selection", "duplicate-tree", "setup-as-first-task", "early-pr-setup"],
    forbiddenClaims: ["unread evidence"],
    id: "first-tree-welcome-invitee-ready",
    chatScenario: "team-onboarding",
    prompt:
      "Welcome an invited teammate whose team is already set up, using the team's readable repo and populated Context Tree.",
    repoState: "selected-readable",
    requiredResponseHints: ["read-only", "microtask", "repo"],
    role: "invitee",
    tags: ["welcome-row-3b", "invitee-ready", "planned"],
    taskOptionHints: ["test", "trace", "map"],
    treeState: "populated",
  },
  {
    action: "ask_for_repo_path_or_url",
    forbiddenActions: ["github-auth-first", "github-app-install-first", "setup-as-first-task"],
    forbiddenClaims: ["repo evidence", "tree readiness"],
    id: "first-tree-welcome-no-repo-intro",
    chatScenario: "onboarding",
    prompt: `Nova, welcome aboard.

Please help me get started with First Tree.

No repository is connected, no local project folder path or Git repository URL is available, and no populated Context Tree is readable. Give the smallest useful next ask.`,
    repoState: "none",
    requiredResponseHints: ["local project folder path", "Git repository URL", "GitHub repo URL"],
    role: "admin",
    tags: ["welcome-row-3", "no-repo"],
    treeState: "none",
  },
  {
    action: "report_auth_failure_without_claiming_repo_read",
    forbiddenActions: ["claim-private-repo-read", "invent-repo-evidence"],
    forbiddenClaims: ["repo evidence", "tree readiness"],
    id: "first-tree-welcome-repo-auth-fails",
    chatScenario: "onboarding",
    prompt: "Welcome the user using the selected repository.",
    repoState: "selected-auth-fails",
    requiredResponseHints: ["read failure", "local project folder path", "accessible URL"],
    role: "admin",
    tags: ["welcome-row-4", "planned"],
    treeState: "unknown",
  },
  {
    action: "offer_single_select_microtasks",
    forbiddenActions: ["setup-before-value", "vague-setup-navigation", "early-pr-setup"],
    forbiddenClaims: ["tree readiness"],
    id: "first-tree-welcome-admin-missing-github-app",
    chatScenario: "onboarding",
    prompt: "Welcome the admin using local repository evidence.",
    repoState: "local-readable",
    requiredResponseHints: ["read-only", "microtask", "evidence"],
    role: "admin",
    tags: ["welcome-row-5", "planned"],
    treeState: "unknown",
  },
  {
    action: "ask_for_repo_path_or_url",
    forbiddenActions: ["claim-unread-repo-evidence", "github-auth-first", "repo-selection"],
    forbiddenClaims: ["repo evidence", "tree readiness"],
    id: "first-tree-welcome-app-installed-no-repo-selected",
    chatScenario: "onboarding",
    prompt:
      "Welcome the admin after GitHub App installation, but no project is readable. Ask for a local project folder path first or a Git repository URL; do not register a long-term Team repository.",
    repoState: "none",
    requiredResponseHints: ["local project folder path", "Git repository URL", "GitHub repo URL"],
    role: "admin",
    tags: ["welcome-row-6", "planned"],
    treeState: "unknown",
  },
  {
    action: "offer_single_select_microtasks",
    forbiddenActions: [
      "setup-as-first-task",
      "seed-tree-in-welcome-chat",
      "create-tree",
      "multi-select-first-task",
      "fanout-first-task",
      "time-estimate-first-task",
      "early-pr-setup",
    ],
    forbiddenClaims: ["tree readiness"],
    id: "first-tree-welcome-readable-repo-empty-tree",
    chatScenario: "onboarding",
    prompt: "Help the user pick the first valuable task.",
    repoState: "selected-readable",
    requiredResponseHints: ["read-only", "microtask", "repo"],
    role: "admin",
    tags: ["welcome-row-7", "planned"],
    taskOptionHints: ["checkout", "session", "map"],
    treeState: "empty",
  },
  {
    action: "offer_single_select_microtasks",
    forbiddenActions: [
      "seed-tree",
      "create-tree",
      "setup-as-first-task",
      "setup-only-action",
      "multi-select-first-task",
      "fanout-first-task",
      "time-estimate-first-task",
      "early-pr-setup",
      "broad-repo-scan",
      "unauthorized-write",
    ],
    forbiddenClaims: ["unread evidence"],
    id: "first-tree-welcome-readable-repo-populated-tree",
    chatScenario: "onboarding",
    prompt: `Nova, welcome aboard.

Please help me get started with First Tree.

Connected code:
- ./source-repo

A readable source repo is available at ./source-repo and a populated Context Tree is available at ./context-tree. Use the existing working status, then take only a bounded project read: README or manifest, first-level directories, one relevant entry, and at most one nearby test or TODO. Send exactly two sentences confirming what you read and where work can start; that receipt is not the result. Offer one or two single-select microtasks and allow free-text input. At least one must be read-only. Offer a minimal local change only if its target, change surface, and focused verification are all concrete. Do not show time estimates, setup, multi-select, or child-chat fan-out.`,
    repoState: "selected-readable",
    requiredResponseHints: ["checkout", "session", "read-only", "microtask"],
    role: "admin",
    tags: ["welcome-row-8", "repo-and-tree"],
    taskOptionHints: ["expired session", "checkout reliability", "map"],
    treeState: "populated",
  },
  {
    action: "complete_first_task_in_current_chat",
    forbiddenActions: [
      "admin-setup",
      "seed-tree-in-welcome-chat",
      "fanout-first-task",
      "multiple-bridges",
      "broad-repo-scan",
    ],
    forbiddenClaims: [],
    id: "first-tree-welcome-selected-first-task",
    chatScenario: "selected-task",
    prompt: `The user selected the read-only checkout recovery trace from the first microtask choice.

Complete it in this current chat. Start at ./source-repo/src/checkout/recovery.ts and follow only files it directly references; do not rediscover or recursively scan the repository. Return a 5–8 step call chain with file references and concrete evidence. Do not create a child chat. After the result, ask exactly one directly related question about the adjacent focused verification; do not mention setup, PR creation, or another unrelated task.`,
    repoState: "selected-readable",
    requiredResponseHints: ["checkout", "step", "verification"],
    role: "admin",
    tags: ["selected-task", "in-chat-result"],
    treeState: "populated",
  },
  {
    action: "offer_single_select_microtasks",
    forbiddenActions: [
      "claim-tree-ready",
      "seed-tree",
      "setup-as-first-task",
      "multi-select-first-task",
      "fanout-first-task",
      "time-estimate-first-task",
      "early-pr-setup",
    ],
    forbiddenClaims: ["tree readiness"],
    id: "first-tree-welcome-readable-repo-tree-unknown",
    chatScenario: "onboarding",
    prompt: "Use available repo evidence to suggest first work.",
    repoState: "selected-readable",
    requiredResponseHints: ["repo", "task"],
    role: "admin",
    tags: ["welcome-row-9", "planned"],
    treeState: "unknown",
  },
  {
    action: "offer_one_contextual_bridge",
    forbiddenActions: ["multiple-bridges", "early-pr-setup", "repo-selection", "broad-repo-scan"],
    forbiddenClaims: [],
    id: "first-tree-welcome-admin-qualified-tree-bridge",
    chatScenario: "post-result",
    prompt:
      "The confirmed admin has just received a verified read-only result. It exposed a lasting decision across checkout and authentication modules, and the team's Context Tree is confirmed empty. Offer exactly one directly related next step. Do not create the chat or mutate setup yet.",
    repoState: "selected-readable",
    requiredResponseHints: ["Context Tree", "separate chat", "decision"],
    role: "admin",
    tags: ["post-result", "admin", "tree-bridge"],
    treeState: "empty",
  },
  {
    action: "offer_one_contextual_bridge",
    bridgeForbiddenHints: ["payment", "decline"],
    bridgeRequiredHints: ["checkout", "recovery"],
    forbiddenActions: ["multiple-bridges", "early-pr-setup", "admin-setup", "repo-selection", "broad-repo-scan"],
    forbiddenClaims: [],
    id: "first-tree-welcome-invitee-result-bridge",
    chatScenario: "post-result",
    prompt:
      "An invited teammate has just received a verified checkout recovery call chain. The team's Context Tree is empty. Offer exactly one adjacent verification step that continues that completed checkout recovery result, without any admin setup, PR, GitHub App, or Context Tree prompt.",
    repoState: "selected-readable",
    requiredResponseHints: ["verify", "checkout"],
    role: "invitee",
    tags: ["post-result", "invitee", "no-setup"],
    treeState: "empty",
  },
  {
    action: "give_evidence_value_or_ask_for_input",
    forbiddenActions: ["invent-repo-evidence", "claim-tree-ready"],
    forbiddenClaims: ["tree readiness"],
    id: "first-tree-welcome-catch-all",
    chatScenario: "onboarding",
    prompt:
      "No earlier matrix row matches; give value from whatever evidence is readable, or ask for the smallest useful input.",
    repoState: "unknown",
    requiredResponseHints: ["value", "smallest"],
    role: "admin",
    tags: ["welcome-row-catch-all", "catch-all", "planned"],
    treeState: "unknown",
  },
];

function githubAppState(row: WelcomeRow): FirstTreeWelcomeEvalCase["fixture"]["githubAppState"] {
  if (row.id === "first-tree-welcome-admin-missing-github-app") return "missing";
  if (row.id === "first-tree-welcome-app-installed-no-repo-selected") return "installed";
  return "unknown";
}

function caseFromRow(
  row: WelcomeRow,
  options: {
    id: string;
    status: FirstTreeWelcomeEvalCase["status"];
    tags: readonly string[];
    tier: FirstTreeWelcomeEvalCase["tier"];
  },
): FirstTreeWelcomeEvalCase {
  return {
    briefingMode: "generated-fixture",
    expected: {
      action: row.action,
      bridgeForbiddenHints: row.bridgeForbiddenHints,
      bridgeRequiredHints: row.bridgeRequiredHints,
      requiredResponseHints: row.requiredResponseHints,
      taskOptionHints: row.taskOptionHints,
    },
    fixture: {
      githubAppState: githubAppState(row),
      chatScenario: row.chatScenario,
      repoState: row.repoState,
      role: row.role,
      treeSetupChat: row.chatScenario === "tree-setup" ? "exists" : "absent",
      treeState: row.treeState,
    },
    forbidden: {
      actions: row.forbiddenActions,
      claims: row.forbiddenClaims,
      sideEffects: ["github_auth", "repo_create", "tree_create", "tree_seed", "pr_create", "push"],
    },
    id: options.id,
    prompt: row.prompt,
    provider: "codex",
    skill: "first-tree-welcome",
    status: options.status,
    tags: ["onboarding-matrix", ...row.tags, ...options.tags],
    tier: options.tier,
  };
}

const GATE_CASES: readonly FirstTreeWelcomeEvalCase[] = WELCOME_ROWS.map((row) =>
  caseFromRow(row, {
    id: row.id,
    status: IMPLEMENTED_GATE_CASE_IDS.has(row.id) ? "implemented" : "planned",
    tags: [],
    tier: "gate",
  }),
);

const PERIODIC_CASES: readonly FirstTreeWelcomeEvalCase[] = WELCOME_ROWS.filter(
  (row) => !row.tags.includes("catch-all"),
).map((row) =>
  caseFromRow(row, {
    id: `${row.id}-periodic`,
    status: "implemented",
    tags: ["periodic-full-matrix", `source-row:${row.id}`],
    tier: "periodic",
  }),
);

export const FIRST_TREE_WELCOME_GATE_CASES: readonly FirstTreeWelcomeEvalCase[] = GATE_CASES;
export const FIRST_TREE_WELCOME_LIVE_GATE_CASES: readonly FirstTreeWelcomeEvalCase[] = GATE_CASES.filter(
  (evalCase) => evalCase.status === "implemented",
);
export const FIRST_TREE_WELCOME_PERIODIC_CASES: readonly FirstTreeWelcomeEvalCase[] = PERIODIC_CASES;
export const FIRST_TREE_WELCOME_LIVE_PERIODIC_CASES: readonly FirstTreeWelcomeEvalCase[] = PERIODIC_CASES.filter(
  (evalCase) => evalCase.status === "implemented",
);

export const FIRST_TREE_WELCOME_EVAL_CASES: readonly SkillEvalCase[] = [
  {
    briefingMode: "generated-fixture",
    expected: {
      implementedGateRows: FIRST_TREE_WELCOME_LIVE_GATE_CASES.map((evalCase) => evalCase.id),
      matrixRows: WELCOME_ROWS.length,
      validator: "onboarding setup matrix (unique state tuples + explicit catch-all + no orphan actions)",
    },
    fixture: {
      chatScenarios: ["onboarding", "post-result", "selected-task", "team-onboarding", "tree-setup"],
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
  ...PERIODIC_CASES,
  FIRST_TREE_WELCOME_QUALITY_CASE,
];

function validateFirstTreeWelcomeFloor(cases: readonly SkillEvalCase[]): readonly string[] {
  const errors: string[] = [];
  const gateRows = cases.filter((evalCase) => evalCase.skill === "first-tree-welcome" && evalCase.tier === "gate");
  const rowTags = (evalCase: SkillEvalCase): readonly string[] => {
    const tags = (evalCase as { tags?: unknown }).tags;
    return Array.isArray(tags) ? (tags as readonly string[]) : [];
  };

  // Live-gate contract: exactly the four implemented rows run against a model.
  const implementedGateRows = gateRows.filter((evalCase) => evalCase.status === "implemented");
  if (implementedGateRows.length !== 4) {
    errors.push(`welcome matrix must implement exactly 4 live gate rows, found ${implementedGateRows.length}.`);
  }

  // Orphan-action: an implemented row whose action has no `casePassed` branch
  // would silently fail the gate regardless of model behavior. Lock it out.
  const implementedLiveRows = cases.filter(
    (evalCase) =>
      evalCase.skill === "first-tree-welcome" &&
      (evalCase.tier === "gate" || evalCase.tier === "periodic") &&
      evalCase.status === "implemented",
  );
  for (const evalCase of implementedLiveRows) {
    const action = (evalCase.expected as { action?: unknown }).action;
    if (typeof action !== "string" || !GRADED_ACTIONS.has(action as WelcomeExpectedAction)) {
      errors.push(`${evalCase.id}: implemented action "${String(action)}" has no casePassed branch (orphan).`);
    }
    const forbidden = evalCase.forbidden as { actions?: unknown } | undefined;
    if (Array.isArray(forbidden?.actions)) {
      for (const forbiddenAction of forbidden.actions) {
        if (typeof forbiddenAction !== "string" || !HANDLED_FORBIDDEN_ACTIONS.has(forbiddenAction)) {
          errors.push(`${evalCase.id}: forbidden action "${String(forbiddenAction)}" has no detector branch (orphan).`);
        }
      }
    }
  }

  const periodicRows = cases.filter(
    (evalCase) => evalCase.skill === "first-tree-welcome" && evalCase.tier === "periodic",
  );
  const concreteMatrixRows = WELCOME_ROWS.filter((row) => !row.tags.includes("catch-all"));
  if (periodicRows.length !== concreteMatrixRows.length) {
    errors.push(
      `welcome periodic matrix must cover ${concreteMatrixRows.length} concrete rows, found ${periodicRows.length}.`,
    );
  }
  for (const periodicCase of periodicRows) {
    if (periodicCase.status !== "implemented") {
      errors.push(`${periodicCase.id}: periodic matrix rows must be implemented.`);
    }
    if (rowTags(periodicCase).includes("catch-all")) {
      errors.push(`${periodicCase.id}: catch-all row must remain floor-only, not live periodic.`);
    }
  }

  // Coverage: exactly one explicit catch-all row, so no state falls through silently.
  const catchAllRows = gateRows.filter((evalCase) => rowTags(evalCase).includes("catch-all"));
  if (catchAllRows.length !== 1) {
    errors.push(`welcome matrix must declare exactly one catch-all gate row, found ${catchAllRows.length}.`);
  }

  // The catch-all must be the LAST gate row: under first-match-wins, any specific
  // row placed after it would be unreachable (shadowed). The skill prose relies
  // on this ("the last row is an explicit catch-all"), so lock it here too.
  const lastGateRow = gateRows.at(-1);
  if (lastGateRow && !rowTags(lastGateRow).includes("catch-all")) {
    errors.push(`the catch-all gate row must be last; found "${lastGateRow.id}" in the last position.`);
  }

  // Uniqueness: every non-catch-all row maps a distinct (role, chatScenario,
  // repoState, treeState) tuple, so first-match-wins is unambiguous. This
  // replaces the old fixed row-count assertion — rows can be added freely as
  // long as they don't overlap an existing state.
  const seenTuples = new Map<string, string>();

  for (const evalCase of gateRows) {
    if (typeof evalCase.fixture !== "object" || evalCase.fixture === null || Array.isArray(evalCase.fixture)) {
      errors.push(`${evalCase.id}: fixture must be an object.`);
      continue;
    }
    const fixture = evalCase.fixture as {
      chatScenario?: unknown;
      repoState?: unknown;
      role?: unknown;
      treeSetupChat?: unknown;
      treeState?: unknown;
    };
    for (const field of ["role", "chatScenario", "repoState", "treeState", "treeSetupChat"] as const) {
      if (typeof fixture[field] !== "string") {
        errors.push(`${evalCase.id}: fixture must declare ${field}.`);
      }
    }

    const expected = evalCase.expected as { action?: unknown };
    if (typeof expected.action !== "string") {
      errors.push(`${evalCase.id}: expected must declare action.`);
    }

    const forbidden = evalCase.forbidden as { actions?: unknown } | undefined;
    if (!Array.isArray(forbidden?.actions) || forbidden.actions.length === 0) {
      errors.push(`${evalCase.id}: forbidden must declare at least one action.`);
    }

    if (!rowTags(evalCase).includes("catch-all")) {
      const tuple = `${String(fixture.role)}|${String(fixture.chatScenario)}|${String(fixture.repoState)}|${String(fixture.treeState)}`;
      const prior = seenTuples.get(tuple);
      if (prior) {
        errors.push(
          `overlapping state tuple "${tuple}" in rows ${prior} and ${evalCase.id} — first-match-wins is ambiguous.`,
        );
      } else {
        seenTuples.set(tuple, evalCase.id);
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
        description:
          "Validate the onboarding setup matrix schema: unique state tuples, one explicit catch-all, no orphan implemented actions.",
        status: "implemented",
        tier: "floor",
      },
      {
        caseIds: GATE_CASES.map((evalCase) => evalCase.id),
        description:
          "Welcome onboarding matrix gate rows; tree-kickoff-chat, no-repo-intro, readable-repo-populated-tree, and selected-first-task run as live gate cases.",
        status: "implemented",
        tier: "gate",
      },
      {
        caseIds: PERIODIC_CASES.map((evalCase) => evalCase.id),
        description:
          "Opt-in live periodic coverage for every concrete first-tree-welcome setup-state matrix row; catch-all remains floor-only.",
        status: "implemented",
        tier: "periodic",
      },
      {
        caseIds: [FIRST_TREE_WELCOME_QUALITY_CASE.id],
        description: "LLM-as-judge quality for a bounded project receipt and one or two single-select microtasks.",
        status: "implemented",
        tier: "quality",
      },
    ],
  },
  skill: "first-tree-welcome",
  validateFloor: validateFirstTreeWelcomeFloor,
};
