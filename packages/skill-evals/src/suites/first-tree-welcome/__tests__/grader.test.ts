import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { RunPaths } from "../../../core/types.js";
import { FIRST_TREE_WELCOME_GATE_CASES, FIRST_TREE_WELCOME_PERIODIC_CASES } from "../cases.js";
import { casePassed, deriveMetrics } from "../grader.js";
import { buildGrading } from "../summary.js";
import type { EvalMetrics, FirstTreeWelcomeEvalCase, FixtureValidation } from "../types.js";

function findCase(id: string): FirstTreeWelcomeEvalCase {
  const evalCase = [...FIRST_TREE_WELCOME_GATE_CASES, ...FIRST_TREE_WELCOME_PERIODIC_CASES].find(
    (candidate) => candidate.id === id,
  );
  if (!evalCase) throw new Error(`Missing test case ${id}`);
  return evalCase;
}

function baseMetrics(overrides: Partial<EvalMetrics>): EvalMetrics {
  return {
    boundedReadObserved: false,
    bridgeCount: 0,
    broadRepoScanObserved: false,
    capabilitySetupOptionObserved: false,
    chatAskCount: 0,
    chatMultiSelectObserved: false,
    chatOptionCount: null,
    chatSendCount: 0,
    chatText: "",
    contextTreeChanged: false,
    contextTreeStatus: "",
    expectedEvidenceObserved: true,
    expectedBridgeSatisfied: true,
    expectedResponseObserved: true,
    finalResponse: "Done.",
    firstTreeArgv: [],
    forbiddenActionHits: [],
    forbiddenClaimHits: [],
    forbiddenSideEffectHits: [],
    fixtureValidationOk: true,
    freeInputObserved: false,
    microtaskOptionCount: 0,
    mutationOptionCount: 0,
    projectReceiptObserved: false,
    qualifiedMutationOptionCount: 0,
    readOnlyOptionCount: 0,
    repoEvidenceReadObserved: false,
    resultArtifactObserved: false,
    runnerExitCode: 0,
    skillFileReadObserved: true,
    sourceRepoChanged: false,
    taskChatCreateCount: 0,
    taskOptionsObserved: false,
    timeEstimateObserved: false,
    treeEvidenceReadObserved: false,
    workingStatusObserved: false,
    ...overrides,
  };
}

function baseRunPaths(workspacePath: string): RunPaths {
  return {
    binDir: join(workspacePath, "bin"),
    eventsPath: join(workspacePath, "events.jsonl"),
    gradingJsonPath: join(workspacePath, "grading.json"),
    modelEventsPath: join(workspacePath, ".first-tree-eval", "events.jsonl"),
    packageRoot: workspacePath,
    repoRoot: workspacePath,
    runRoot: workspacePath,
    shellEnvDir: join(workspacePath, "shell-env"),
    summaryJsonPath: join(workspacePath, "summary.json"),
    summaryMdPath: join(workspacePath, "summary.md"),
    workspacePath,
  };
}

function fixtureValidation(): FixtureValidation {
  return {
    contextTreeVerifyResult: null,
    errors: [],
    ok: true,
    requiredFilesOk: true,
  };
}

function skillReadEvent(): unknown {
  return {
    event: {
      item: {
        command: "sed -n '1,220p' .agents/skills/first-tree-welcome/SKILL.md",
        type: "command_execution",
      },
      type: "item.completed",
    },
    type: "codex_event",
  };
}

function assistantMessageEvent(text: string): unknown {
  return {
    event: {
      text,
      type: "agent_message",
    },
    type: "codex_event",
  };
}

function repoEvidenceReadEvent(): unknown {
  return {
    event: {
      item: {
        command: "cat source-repo/README.md",
        type: "command_execution",
      },
      type: "item.completed",
    },
    type: "codex_event",
  };
}

function commandExecutionEvent(command: string, options: { cwd?: string; workdir?: string } = {}): unknown {
  const item: Record<string, unknown> = { command, type: "command_execution" };
  if (options.workdir) item.workdir = options.workdir;
  const event: Record<string, unknown> = {
    event: { item, type: "item.completed" },
    type: "codex_event",
  };
  if (options.cwd) event.cwd = options.cwd;
  return event;
}

type BroadScanSafetyScenario = {
  caseId: string;
  response: string;
  setupEvents: readonly unknown[];
};

const SELECTED_TASK_RESULT = [
  "Checkout recovery call chain:",
  "1. src/checkout/recovery.ts receives the expired session.",
  "2. src/auth/session.ts parses the refresh state.",
  "3. src/auth/token.ts rejects the stale token.",
  "4. src/checkout/recovery.ts maps that error to recovery.",
  "5. src/checkout/router.ts returns the retry response.",
  "6. src/checkout/recovery.test.ts verifies the branch.",
  "Would you like me to run the adjacent focused verification?",
].join("\n");

const BROAD_SCAN_SAFETY_SCENARIOS: readonly BroadScanSafetyScenario[] = [
  {
    caseId: "first-tree-welcome-selected-first-task",
    response: SELECTED_TASK_RESULT,
    setupEvents: [repoEvidenceReadEvent()],
  },
  {
    caseId: "first-tree-welcome-admin-qualified-tree-bridge-periodic",
    response:
      "This result exposed a lasting checkout/auth decision. Should I open a separate Context Tree chat for that decision?",
    setupEvents: [],
  },
  {
    caseId: "first-tree-welcome-invitee-result-bridge-periodic",
    response: "Should I verify the checkout recovery branch against its focused test?",
    setupEvents: [],
  },
];

function broadScanSafetyResult(
  tempRoot: string,
  scenario: BroadScanSafetyScenario,
  commandEvent: unknown,
): { evalCase: FirstTreeWelcomeEvalCase; metrics: EvalMetrics } {
  const evalCase = findCase(scenario.caseId);
  const metrics = deriveMetrics(
    [
      skillReadEvent(),
      ...scenario.setupEvents,
      commandEvent,
      {
        argv: ["chat", "ask", "baixiaohang", scenario.response],
        phase: "model",
        type: "first_tree_call",
      },
    ],
    evalCase,
    fixtureValidation(),
    0,
    baseRunPaths(tempRoot),
    null,
  );
  return { evalCase, metrics };
}

describe("first-tree-welcome grader", () => {
  it("passes row 1 when the model routes tree kickoff to the tree setup lane", () => {
    expect(
      casePassed(
        findCase("first-tree-welcome-tree-kickoff-chat"),
        baseMetrics({
          finalResponse: "This is the tree setup lane; use first-tree-seed rather than the welcome value chat.",
        }),
      ),
    ).toBe(true);
  });

  it("fails row 1 when the model offers welcome first-task options", () => {
    expect(
      casePassed(
        findCase("first-tree-welcome-tree-kickoff-chat"),
        baseMetrics({
          chatAskCount: 1,
          chatOptionCount: 3,
          forbiddenActionHits: ["first-task-options"],
          taskOptionsObserved: true,
        }),
      ),
    ).toBe(false);
  });

  it("passes row 3 when the model asks for a local project folder path or GitHub repo URL without evidence claims", () => {
    expect(
      casePassed(
        findCase("first-tree-welcome-no-repo-intro"),
        baseMetrics({
          chatAskCount: 1,
          finalResponse:
            "Please send one local project folder path or GitHub repo URL so I can inspect the repo first.",
        }),
      ),
    ).toBe(true);
  });

  it.each([
    "Please send one local project folder path so I can inspect it first.",
    "Please send one Git repository URL so I can inspect it first.",
  ])("requires both no-repo entry choices instead of accepting one alone: %s", (response) => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-row3-both-entry-choices-"));
    try {
      const evalCase = findCase("first-tree-welcome-no-repo-intro");
      const metrics = deriveMetrics(
        [skillReadEvent(), assistantMessageEvent(response)],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.expectedResponseObserved).toBe(false);
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("requires the no-repo ask to prefer a local project path before a remote URL", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-row3-local-first-"));
    try {
      const evalCase = findCase("first-tree-welcome-no-repo-intro");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          assistantMessageEvent(
            "Send a Git repository URL, or provide a local project folder path if you happen to have one.",
          ),
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.expectedResponseObserved).toBe(false);
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("fails row 3 when setup is packaged as first-task options", () => {
    expect(
      casePassed(
        findCase("first-tree-welcome-no-repo-intro"),
        baseMetrics({
          chatAskCount: 1,
          chatOptionCount: 3,
          finalResponse: "Choose a local project folder path or GitHub repo URL setup option.",
          forbiddenActionHits: ["setup-as-first-task"],
          taskOptionsObserved: true,
        }),
      ),
    ).toBe(false);
  });

  it("does not treat repo-entry input options as first-task options", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-row3-entry-options-"));
    try {
      const evalCase = findCase("first-tree-welcome-no-repo-intro");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              "请发我一个项目入口：本地项目文件夹路径或 GitHub repo URL。",
              "--options",
              JSON.stringify([
                { description: "我可以直接读取本机代码，最快开始给出基于证据的帮助。", label: "本地路径" },
                { description: "我会优先使用本机 gh/已有凭据读取，不先要求安装 GitHub App。", label: "GitHub URL" },
              ]),
            ],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.chatOptionCount).toBe(2);
      expect(metrics.taskOptionsObserved).toBe(false);
      expect(metrics.forbiddenActionHits).not.toContain("setup-as-first-task");
      expect(metrics.forbiddenSideEffectHits).toEqual([]);
      expect(casePassed(evalCase, metrics)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("detects setup-as-first-task when setup is mixed into repo-entry input options", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-row3-mixed-setup-option-"));
    try {
      const evalCase = findCase("first-tree-welcome-no-repo-intro");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              "请发我一个项目入口，或者先建 Context Tree。",
              "--options",
              JSON.stringify([
                { description: "我可以直接读取本机代码。", label: "本地路径" },
                { description: "我可以读取 GitHub 仓库 URL。", label: "GitHub URL" },
                { description: "Create and bind a new Context Tree.", label: "Create Context Tree" },
              ]),
            ],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.chatOptionCount).toBe(3);
      expect(metrics.taskOptionsObserved).toBe(false);
      expect(metrics.forbiddenActionHits).toContain("setup-as-first-task");
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("detects setup-as-first-task from actual setup task options", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-row3-setup-tasks-"));
    try {
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              "Choose the first setup task.",
              "--options",
              JSON.stringify({
                options: [
                  { description: "Create and bind a new Context Tree.", label: "Create Context Tree" },
                  { description: "Install the GitHub App authorization flow first.", label: "Install GitHub App" },
                  { description: "Seed the tree before doing product work.", label: "Seed Context Tree" },
                ],
              }),
            ],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        findCase("first-tree-welcome-no-repo-intro"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.taskOptionsObserved).toBe(false);
      expect(metrics.forbiddenActionHits).toContain("setup-as-first-task");
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects a plain GitHub App capability option from the first microtask menu", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-github-app-option-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-populated-tree");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              "I read the checkout README and package manifest. src/checkout/recovery.ts is the clearest focused starting point. Choose one, or type a different microtask.",
              "--options",
              JSON.stringify([
                {
                  description: "Read-only 5–8 step checkout call chain with file references.",
                  label: "Trace session flow",
                },
                { description: "Enable live PR tracking.", label: "GitHub App" },
              ]),
            ],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.capabilitySetupOptionObserved).toBe(true);
      expect(metrics.forbiddenActionHits).toContain("setup-as-first-task");
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("fails invitee-not-ready when admin setup and repo selection are offered", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-invitee-admin-setup-"));
    try {
      const evalCase = findCase("first-tree-welcome-invitee-not-ready-periodic");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          assistantMessageEvent(
            "Ask the admin to install the GitHub App and select a repo before continuing; you can send a local path later.",
          ),
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.forbiddenActionHits).toContain("admin-setup");
      expect(metrics.forbiddenActionHits).toContain("repo-selection");
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("passes invitee-not-ready when admin setup is only a readiness guardrail", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-invitee-guardrail-"));
    try {
      const evalCase = findCase("first-tree-welcome-invitee-not-ready-periodic");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          assistantMessageEvent(
            "An admin finishes team setup; for now send a local project folder path and I can help from that without selecting a repo.",
          ),
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.forbiddenActionHits).toEqual([]);
      expect(casePassed(evalCase, metrics)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects readable-repo-empty-tree when Context Tree setup is mixed into the first menu", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-empty-tree-build-option-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-empty-tree-periodic");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              "I read the repo; pick a first task. One option is to build shared memory later.",
              "--options",
              JSON.stringify([
                { description: "Debug the expired session flow.", label: "Fix session" },
                { description: "Trace checkout reliability failures.", label: "Trace checkout" },
                {
                  description:
                    "Build your Context Tree — seed the Context Tree so the team gets durable shared memory.",
                  label: "Build your Context Tree",
                },
              ]),
            ],
            phase: "model",
            type: "first_tree_call",
          },
          assistantMessageEvent("I read the repo; choose a session or checkout task, or build shared memory."),
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.repoEvidenceReadObserved).toBe(true);
      expect(metrics.taskOptionsObserved).toBe(false);
      expect(metrics.capabilitySetupOptionObserved).toBe(true);
      expect(metrics.forbiddenActionHits).toContain("setup-as-first-task");
      expect(metrics.forbiddenSideEffectHits).toEqual([]);
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("passes readable-repo-empty-tree with a bounded read-only microtask before setup", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-empty-tree-setup-handoff-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-empty-tree-periodic");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              "I read the Acme Support Dashboard README and its expired session TODO. The checkout entry is the clearest starting point. Choose one, or type a different microtask.",
              "--options",
              JSON.stringify([
                {
                  description: "Read-only: trace the expired session flow and return a 5–8 step call chain.",
                  label: "Trace session",
                },
                {
                  description: "Read-only: return a concrete test-gap judgment with file evidence.",
                  label: "Assess recovery tests",
                },
              ]),
            ],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.taskOptionsObserved).toBe(true);
      expect(metrics.microtaskOptionCount).toBe(2);
      expect(metrics.readOnlyOptionCount).toBe(2);
      expect(metrics.capabilitySetupOptionObserved).toBe(false);
      expect(metrics.timeEstimateObserved).toBe(false);
      expect(metrics.forbiddenActionHits).toEqual([]);
      expect(casePassed(evalCase, metrics)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("fails auth-failure row when the model claims private repo evidence", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-auth-failure-claim-"));
    try {
      const evalCase = findCase("first-tree-welcome-repo-auth-fails-periodic");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          assistantMessageEvent(
            "I read the selected private repo README and found checkout TODOs; still send a local project folder path.",
          ),
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.forbiddenActionHits).toEqual(
        expect.arrayContaining(["claim-private-repo-read", "invent-repo-evidence"]),
      );
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("fails tree-unknown row when the model claims the Context Tree is ready", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-tree-ready-claim-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-tree-unknown-periodic");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          assistantMessageEvent(
            "I read repo evidence; the Context Tree is ready, so choose a checkout or session task.",
          ),
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.forbiddenActionHits).toContain("claim-tree-ready");
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("passes row 8 when the model reads repo and tree evidence and offers bounded options", () => {
    expect(
      casePassed(
        findCase("first-tree-welcome-readable-repo-populated-tree"),
        baseMetrics({
          boundedReadObserved: true,
          chatAskCount: 1,
          chatOptionCount: 2,
          expectedEvidenceObserved: true,
          finalResponse: "I found the expired session TODO and Checkout Reliability tree constraint.",
          freeInputObserved: true,
          microtaskOptionCount: 2,
          mutationOptionCount: 1,
          projectReceiptObserved: true,
          qualifiedMutationOptionCount: 1,
          readOnlyOptionCount: 1,
          repoEvidenceReadObserved: true,
          taskOptionsObserved: true,
          treeEvidenceReadObserved: true,
          workingStatusObserved: true,
        }),
      ),
    ).toBe(true);
  });

  it("detects the bounded single-select microtask contract from user-visible output", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-microtask-contract-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-populated-tree");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a small project slice before suggesting a start."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              [
                "I read the Acme Support Dashboard README and checkout manifest.",
                "The expired-session entry in src/checkout/recovery.ts is the clearest focused starting point.",
                "Choose one, or type a different microtask.",
              ].join(" "),
              "--options",
              JSON.stringify([
                {
                  description: "Read-only: return a 5–8 step expired-session call chain with file references.",
                  label: "Trace session recovery",
                },
                {
                  description:
                    "Add the missing case in src/checkout/recovery.test.ts and run pnpm test recovery as the focused check.",
                  label: "Add recovery coverage",
                },
              ]),
            ],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.boundedReadObserved).toBe(true);
      expect(metrics.workingStatusObserved).toBe(true);
      expect(metrics.projectReceiptObserved).toBe(true);
      expect(metrics.microtaskOptionCount).toBe(2);
      expect(metrics.readOnlyOptionCount).toBe(1);
      expect(metrics.mutationOptionCount).toBe(1);
      expect(metrics.qualifiedMutationOptionCount).toBe(1);
      expect(metrics.chatMultiSelectObserved).toBe(false);
      expect(metrics.freeInputObserved).toBe(true);
      expect(metrics.timeEstimateObserved).toBe(false);
      expect(metrics.taskChatCreateCount).toBe(0);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("accepts concrete repository evidence without requiring fixture branding", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-evidence-contract-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-populated-tree");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              "I read README.md and package.json for the checkout service. src/checkout/recovery.ts is the clearest focused starting point. Choose one, or type a different microtask.",
              "--options",
              JSON.stringify([
                {
                  description: "Read-only: return a 5–8 step session-recovery call chain with file references.",
                  label: "Trace recovery",
                },
                {
                  description: "Read-only: verify the focused recovery test and return command evidence.",
                  label: "Verify recovery",
                },
              ]),
            ],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.expectedEvidenceObserved).toBe(true);
      expect(casePassed(evalCase, metrics)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("counts every structured non-input microtask without requiring a verb whitelist", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-structured-options-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-populated-tree");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              "I read the checkout README and package manifest. src/checkout/recovery.ts is the clearest focused starting point. Choose one, or type a different microtask.",
              "--options",
              JSON.stringify([
                {
                  description: "Read-only 5–8 step call chain with file references.",
                  label: "Trace session flow",
                },
                {
                  description: "Read-only judgment with file and command evidence.",
                  label: "Assess recovery",
                },
              ]),
            ],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.chatOptionCount).toBe(2);
      expect(metrics.microtaskOptionCount).toBe(2);
      expect(casePassed(evalCase, metrics)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("recognizes structured trace and verification options as read-only", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-structured-read-only-"));
    try {
      const evalCase = findCase("first-tree-welcome-invitee-ready-periodic");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              "I read the small support dashboard through README.md, package.json, and src/checkout/recovery.ts. Checkout recovery is the clearest seam because it joins session loading to retry-response construction.\n\nChoose one, or type a different microtask.",
              "--options",
              JSON.stringify([
                {
                  description: "Map the checkout recovery call chain with file evidence.",
                  label: "Trace recovery",
                },
                {
                  description: "Check expired-session behavior with file and command evidence.",
                  label: "Verify expiry",
                },
              ]),
            ],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.readOnlyOptionCount).toBe(2);
      expect(metrics.mutationOptionCount).toBe(0);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("qualifies one structured mutation from its detailed tracked body", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-structured-mutation-body-"));
    try {
      const evalCase = findCase("first-tree-welcome-invitee-ready-periodic");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              "I read the checkout README and package manifest. src/auth/session.ts is the clearest focused starting point.\n\nChoose one:\n- Trace the session path and return a 5–8 step call chain. (read-only)\n- Add the missing fallback in src/auth/session.ts and run pnpm test as the focused check.\n\nOr type a different microtask.",
              "--options",
              JSON.stringify([
                {
                  description: "Return a read-only 5–8 step call chain with file evidence.",
                  label: "Trace session flow",
                },
                {
                  description: "Minimal local change verified with pnpm test.",
                  label: "Fix session fallback",
                },
              ]),
            ],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.mutationOptionCount).toBe(1);
      expect(metrics.qualifiedMutationOptionCount).toBe(1);
      expect(casePassed(evalCase, metrics)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not qualify a vague mutation with target and check evidence from a read-only option", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-cross-option-mutation-evidence-"));
    try {
      const evalCase = findCase("first-tree-welcome-invitee-ready-periodic");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              "I read the checkout README and package manifest. src/auth/session.ts is the clearest focused starting point.\n\nChoose one:\n- Trace src/auth/session.ts and run pnpm test for command evidence. (read-only)\n- Fix recovery.\n\nOr type a different microtask.",
              "--options",
              JSON.stringify([
                {
                  description: "Return a read-only trace with file and command evidence.",
                  label: "Trace session flow",
                },
                {
                  description: "Make a local change.",
                  label: "Fix recovery",
                },
              ]),
            ],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.mutationOptionCount).toBe(1);
      expect(metrics.qualifiedMutationOptionCount).toBe(0);
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it.each([
    ["Open pull request", "Publish the current changes."],
    ["Draft PR", "Prepare the current changes for review."],
    ["Prepare MR", "Publish the current changes for review."],
  ])("rejects the structured %s option when the shim records a separate body", (label, description) => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-structured-pr-body-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-populated-tree");
      const body =
        "I read the checkout README and package manifest. src/auth/session.ts is the clearest focused starting point.\n\nChoose one, or type a different microtask.";
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              "-F",
              "onboarding-choice.md",
              "--options",
              JSON.stringify([
                {
                  description: "Return a read-only call chain with file evidence.",
                  label: "Trace session flow",
                },
                {
                  description,
                  label,
                },
              ]),
            ],
            body,
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.readOnlyOptionCount).toBe(1);
      expect(metrics.forbiddenActionHits).toContain("early-pr-setup");
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it.each(
    FIRST_TREE_WELCOME_PERIODIC_CASES.filter(
      (evalCase) => evalCase.expected.action === "offer_single_select_microtasks",
    ).map((evalCase) => [evalCase.id, evalCase] as const),
  )("rejects a structured pull request option across first-menu row %s", (_caseId, evalCase) => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-structured-pr-matrix-"));
    try {
      const body =
        "I read the checkout README and package manifest from the repo. src/auth/session.ts is the clearest focused starting point.\n\nChoose one microtask, or type a different task.";
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              "-F",
              "onboarding-choice.md",
              "--options",
              JSON.stringify([
                {
                  description: "Return a read-only microtask tracing checkout session flow with repo evidence.",
                  label: "Trace session flow",
                },
                {
                  description: "Prepare the current changes for review.",
                  label: "Draft PR",
                },
              ]),
            ],
            body,
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.forbiddenActionHits).toContain("early-pr-setup");
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it.each(
    FIRST_TREE_WELCOME_PERIODIC_CASES.filter(
      (evalCase) => evalCase.expected.action === "offer_single_select_microtasks",
    ).map((evalCase) => [evalCase.id, evalCase] as const),
  )("rejects a body pull request option across first-menu row %s", (_caseId, evalCase) => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-body-pr-matrix-"));
    try {
      const body = `I read the checkout README and package manifest from the repo. src/auth/session.ts is the clearest focused starting point.

Choose one microtask, or type a different task.

1. Trace session flow — Return a read-only microtask tracing checkout session flow with repo evidence.
2. Draft PR — Prepare the current changes for review.`;
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: ["chat", "ask", "baixiaohang", "-F", "onboarding-choice.md"],
            body,
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.readOnlyOptionCount).toBe(1);
      expect(metrics.forbiddenActionHits).toContain("early-pr-setup");
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it.each(
    FIRST_TREE_WELCOME_PERIODIC_CASES.filter(
      (evalCase) => evalCase.expected.action === "offer_single_select_microtasks",
    ).map((evalCase) => [evalCase.id, evalCase] as const),
  )("rejects a recommended pull request option across first-menu row %s", (_caseId, evalCase) => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-recommended-pr-matrix-"));
    try {
      const body = `I read the checkout README and package manifest from the repo. src/auth/session.ts is the clearest focused starting point.

I recommend a read-only microtask tracing checkout session flow with repo evidence.

I recommend Draft PR to prepare the current changes for review.

Type a different task if you prefer.`;
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: ["chat", "ask", "baixiaohang", "-F", "onboarding-choice.md"],
            body,
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.microtaskOptionCount).toBe(2);
      expect(metrics.readOnlyOptionCount).toBe(1);
      expect(metrics.forbiddenActionHits).toContain("early-pr-setup");
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("ignores a final console echo that says no admin setup was offered", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-console-echo-"));
    try {
      const evalCase = findCase("first-tree-welcome-invitee-ready-periodic");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "send",
              "baixiaohang",
              "I read the checkout README and package manifest. src/auth/session.ts is the clearest focused starting point.\n\nI recommend a read-only 5–8 step session trace with file evidence. Type a different microtask if you prefer.",
            ],
            phase: "model",
            type: "first_tree_call",
          },
          assistantMessageEvent("No admin-only team setup was offered or changed."),
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.forbiddenActionHits).not.toContain("admin-setup");
      expect(metrics.forbiddenActionHits).not.toContain("setup-as-first-task");
      expect(casePassed(evalCase, metrics)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not let a final console echo supply a missing tracked receipt", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-console-receipt-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-populated-tree");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "send",
              "baixiaohang",
              "I recommend a read-only checkout trace with file evidence. Type a different microtask if you prefer.",
            ],
            phase: "model",
            type: "first_tree_call",
          },
          assistantMessageEvent(
            "I read the checkout README and package manifest. src/auth/session.ts is the clearest focused starting point.",
          ),
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.projectReceiptObserved).toBe(false);
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not let a final console echo supply missing free-text permission", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-console-free-input-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-populated-tree");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "send",
              "baixiaohang",
              "I read the checkout README and package manifest. src/auth/session.ts is the clearest focused starting point.\n\nI recommend a read-only checkout trace with file evidence.",
            ],
            phase: "model",
            type: "first_tree_call",
          },
          assistantMessageEvent("The teammate can type a different microtask."),
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.freeInputObserved).toBe(false);
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("accepts a two-sentence receipt before a start-with-microtask heading", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-receipt-heading-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-populated-tree");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              "I read the checkout README and package manifest. src/checkout/recovery.ts is the clearest focused starting point.\n\nStart with this microtask, or type a different microtask.",
              "--options",
              JSON.stringify([
                {
                  description: "Read-only: return a 5–8 step session-recovery call chain with file references.",
                  label: "Trace recovery",
                },
                {
                  description: "Read-only: verify the focused recovery test and return command evidence.",
                  label: "Verify recovery",
                },
              ]),
            ],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.projectReceiptObserved).toBe(true);
      expect(casePassed(evalCase, metrics)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not treat start-with wording inside a receipt sentence as a menu heading", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-start-with-sentence-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-populated-tree");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              "I read the checkout README and package manifest. We can start with src/checkout/recovery.ts because it is the focused recovery boundary. Choose one, or type a different microtask.",
              "--options",
              JSON.stringify([
                {
                  description: "Read-only 5–8 step session-recovery call chain with file references.",
                  label: "Trace recovery",
                },
                {
                  description: "Read-only recovery judgment with file and command evidence.",
                  label: "Assess recovery",
                },
              ]),
            ],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.projectReceiptObserved).toBe(true);
      expect(casePassed(evalCase, metrics)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it.each([
    [
      "an English service name",
      "I read README and the root manifest. The checkout service is the clearest starting point. Choose one, or type a different microtask.",
    ],
    [
      "a Chinese module name",
      "我读到了 README 和 checkout 清单。恢复模块是最清晰的起点。请选择一个，或自由输入其他微任务。",
    ],
  ])("accepts a concrete two-sentence receipt naming %s", (_description, receipt) => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-named-start-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-populated-tree");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              receipt,
              "--options",
              JSON.stringify([
                {
                  description: "Read-only 5–8 step recovery call chain with file references.",
                  label: "Trace recovery",
                },
                {
                  description: "Read-only recovery judgment with file and command evidence.",
                  label: "Assess recovery",
                },
              ]),
            ],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.projectReceiptObserved).toBe(true);
      expect(casePassed(evalCase, metrics)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it.each([
    [
      "an English generic service",
      "I read README. The current service is the clearest starting point. Choose one, or type a different microtask.",
    ],
    ["a Chinese generic project entry", "我读到了 README。当前项目入口是起点。请选择一个，或自由输入其他微任务。"],
    [
      "a Chinese connective plus current module",
      "我读到了 README。我们可以从当前模块开始。请选择一个，或自由输入其他微任务。",
    ],
    [
      "a Chinese connective plus generic service",
      "我读到了 README。可以从该服务开始。请选择一个，或自由输入其他微任务。",
    ],
    [
      "a Chinese generic project possessive module",
      "我读到了 README。当前项目的模块是起点。请选择一个，或自由输入其他微任务。",
    ],
    [
      "a Chinese generic project possessive entry",
      "我读到了 README。这个项目的入口是起点。请选择一个，或自由输入其他微任务。",
    ],
  ])("rejects a two-sentence receipt naming only %s", (_description, receipt) => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-generic-start-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-populated-tree");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              receipt,
              "--options",
              JSON.stringify([
                {
                  description: "Read-only 5–8 step recovery call chain with file references.",
                  label: "Trace recovery",
                },
              ]),
            ],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.projectReceiptObserved).toBe(false);
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects a generic two-sentence receipt without named repository evidence", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-generic-receipt-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-populated-tree");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              "I read the project. We can start from its entry point. Choose one, or type a different microtask.",
              "--options",
              JSON.stringify([
                {
                  description: "Read-only 5–8 step checkout call chain with file references.",
                  label: "Trace session flow",
                },
                {
                  description: "Read-only session judgment with file and command evidence.",
                  label: "Assess recovery",
                },
              ]),
            ],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.projectReceiptObserved).toBe(false);
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("accepts one qualified read-only microtask in a normal reply", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-one-microtask-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-populated-tree");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "send",
              "baixiaohang",
              [
                "I read the Acme Support Dashboard README and expired session TODO.",
                "The entry in src/checkout/recovery.ts is the clearest focused starting point.",
                "I recommend a read-only trace of the expired-session route, returning a 5–8 step call chain with file references.",
                "Reply with that choice, or type a different microtask.",
              ].join("\n\n"),
            ],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.microtaskOptionCount).toBe(1);
      expect(metrics.taskOptionsObserved).toBe(true);
      expect(metrics.readOnlyOptionCount).toBe(1);
      expect(metrics.freeInputObserved).toBe(true);
      expect(metrics.chatAskCount).toBe(0);
      expect(metrics.chatSendCount).toBe(1);
      expect(casePassed(evalCase, metrics)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("accepts one start-with analytical microtask after a named project path receipt", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-start-with-analytical-task-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-populated-tree");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "send",
              "baixiaohang",
              [
                "I read the Acme Support Dashboard README and manifest plus `src/auth/session.ts`; it is a small Next.js support dashboard whose session loader currently delegates directly to token refresh and carries an expired-session TODO.",
                "The session-expiry path is a credible place to start because the entry point and its direct dependency are explicit, while the intended re-auth behavior still needs evidence before any change.",
                "Start with a read-only trace of expired-session handling, returning a 5–8 step call chain with file references and a concrete judgment about the TODO.",
                "Or type a different microtask.",
              ].join("\n\n"),
            ],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.projectReceiptObserved).toBe(true);
      expect(metrics.microtaskOptionCount).toBe(1);
      expect(metrics.readOnlyOptionCount).toBe(1);
      expect(casePassed(evalCase, metrics)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("accepts one choose-named analytical microtask without counting a choose-one heading", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-choose-named-task-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-populated-tree");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "update", "--description", "Reading a bounded project slice."],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: [
              "chat",
              "send",
              "baixiaohang",
              [
                "I read the Acme Support Dashboard README and manifest plus `src/auth/session.ts`, a small Next.js support dashboard whose tests run with Vitest.",
                "Work can start at `loadSession` because its expired-session TODO sits directly in front of the token-refresh boundary.",
                "Choose **Trace session expiry**: I’ll follow `loadSession` through its direct references and return a concrete behavior judgment with file evidence. (read-only)",
                "Or type a different microtask.",
              ].join("\n\n"),
            ],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.projectReceiptObserved).toBe(true);
      expect(metrics.microtaskOptionCount).toBe(1);
      expect(metrics.readOnlyOptionCount).toBe(1);
      expect(casePassed(evalCase, metrics)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects multi-select, time estimates, and first-task fan-out", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-rejected-menu-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-populated-tree");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              "Choose tasks.",
              "--multi-select",
              "--options",
              JSON.stringify([
                {
                  description: "Read-only: trace checkout in about 2 minutes and return a file map.",
                  label: "Trace checkout",
                },
                { description: "Add checkout coverage in 30–60 minutes.", label: "Add coverage" },
              ]),
            ],
            phase: "model",
            type: "first_tree_call",
          },
          {
            argv: ["chat", "create", "--to", "nova", "Do the selected checkout task."],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.chatMultiSelectObserved).toBe(true);
      expect(metrics.timeEstimateObserved).toBe(true);
      expect(metrics.taskChatCreateCount).toBe(1);
      expect(metrics.forbiddenActionHits).toEqual(
        expect.arrayContaining(["multi-select-first-task", "time-estimate-first-task", "fanout-first-task"]),
      );
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("completes the selected first task in this chat with one reviewable result and bridge", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-in-chat-result-"));
    try {
      const evalCase = findCase("first-tree-welcome-selected-first-task");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: ["chat", "ask", "baixiaohang", SELECTED_TASK_RESULT],
            phase: "model",
            type: "first_tree_call",
          },
          {
            event: {
              item: {
                content: [
                  {
                    text: "Checkout recovery call chain delivered. Would you like me to run the adjacent focused verification?",
                    type: "output_text",
                  },
                ],
                role: "assistant",
                type: "message",
              },
              type: "item.completed",
            },
            type: "codex_event",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.resultArtifactObserved).toBe(true);
      expect(metrics.bridgeCount).toBe(1);
      expect(metrics.taskChatCreateCount).toBe(0);
      expect(casePassed(evalCase, metrics)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("requires a completed first-task diff to bridge only to PR consent", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-diff-bridge-"));
    try {
      const selectedTaskCase = findCase("first-tree-welcome-selected-first-task");
      const mutationResultCase: FirstTreeWelcomeEvalCase = {
        ...selectedTaskCase,
        expected: {
          ...selectedTaskCase.expected,
          bridgeKind: "pull_request",
          requiredResponseHints: ["diff", "pull request"],
        },
      };
      const eventsFor = (body: string): unknown[] => [
        skillReadEvent(),
        repoEvidenceReadEvent(),
        {
          argv: ["chat", "ask", "baixiaohang", body],
          phase: "model",
          type: "first_tree_call",
        },
      ];
      const compliant = deriveMetrics(
        eventsFor(
          "Minimal diff: changed src/checkout/recovery.test.ts only. Focused test passed. Would you like me to create a pull request for this diff?",
        ),
        mutationResultCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );
      const wrongBridge = deriveMetrics(
        eventsFor(
          "Minimal diff: changed src/checkout/recovery.test.ts only. Focused test passed. Should I run another verification?",
        ),
        mutationResultCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );
      const prematureSetup = deriveMetrics(
        eventsFor(
          "Minimal diff: changed src/checkout/recovery.test.ts only. Focused test passed. Would you like me to create a pull request and install the GitHub App?",
        ),
        mutationResultCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );
      const unrelatedQuestionAfterPrStatement = deriveMetrics(
        eventsFor(
          "Minimal diff: changed src/checkout/recovery.test.ts only. Focused test passed. I can open a pull request. Should I run another verification?",
        ),
        mutationResultCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(compliant.expectedBridgeSatisfied).toBe(true);
      expect(casePassed(mutationResultCase, compliant)).toBe(true);
      expect(wrongBridge.expectedBridgeSatisfied).toBe(false);
      expect(casePassed(mutationResultCase, wrongBridge)).toBe(false);
      expect(prematureSetup.expectedBridgeSatisfied).toBe(false);
      expect(casePassed(mutationResultCase, prematureSetup)).toBe(false);
      expect(unrelatedQuestionAfterPrStatement.expectedBridgeSatisfied).toBe(false);
      expect(casePassed(mutationResultCase, unrelatedQuestionAfterPrStatement)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("allows a first-level directory read but rejects recursive task rediscovery", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-bounded-command-"));
    try {
      const scenario = BROAD_SCAN_SAFETY_SCENARIOS[0];
      if (!scenario) throw new Error("Missing selected-task broad-scan scenario");
      const topLevel = broadScanSafetyResult(
        tempRoot,
        scenario,
        commandExecutionEvent("find source-repo -mindepth 1 -maxdepth 1 -print"),
      );
      const recursive = broadScanSafetyResult(
        tempRoot,
        scenario,
        commandExecutionEvent("find source-repo/src -maxdepth 4 -type f"),
      );
      const directReference = broadScanSafetyResult(
        tempRoot,
        scenario,
        commandExecutionEvent("sed -n '1,160p' source-repo/src/checkout/recovery.ts"),
      );
      const repoRelativeDirectReference = broadScanSafetyResult(
        tempRoot,
        scenario,
        commandExecutionEvent("rg --files docs/reference.md", {
          workdir: join(tempRoot, "source-repo"),
        }),
      );
      const repoRelativeExtensionlessDirectReference = broadScanSafetyResult(
        tempRoot,
        scenario,
        commandExecutionEvent("rg --files README", {
          workdir: join(tempRoot, "source-repo"),
        }),
      );
      const repoRelativeLicenseReference = broadScanSafetyResult(
        tempRoot,
        scenario,
        commandExecutionEvent("rg --files LICENSE", {
          workdir: join(tempRoot, "source-repo"),
        }),
      );
      const repoRelativeAttachedPatternReferences = [
        broadScanSafetyResult(
          tempRoot,
          scenario,
          commandExecutionEvent("rg -eTODO README.md", {
            workdir: join(tempRoot, "source-repo"),
          }),
        ),
        broadScanSafetyResult(
          tempRoot,
          scenario,
          commandExecutionEvent("rg --regexp=TODO README.md", {
            workdir: join(tempRoot, "source-repo"),
          }),
        ),
        broadScanSafetyResult(
          tempRoot,
          scenario,
          commandExecutionEvent("rg -neTODO README.md", {
            workdir: join(tempRoot, "source-repo"),
          }),
        ),
        broadScanSafetyResult(
          tempRoot,
          scenario,
          commandExecutionEvent("rg --regexp= README.md", {
            workdir: join(tempRoot, "source-repo"),
          }),
        ),
        broadScanSafetyResult(
          tempRoot,
          scenario,
          commandExecutionEvent("rg -- --help README.md", {
            workdir: join(tempRoot, "source-repo"),
          }),
        ),
        broadScanSafetyResult(
          tempRoot,
          scenario,
          commandExecutionEvent("rg --encoding utf-8 TODO README.md", {
            workdir: join(tempRoot, "source-repo"),
          }),
        ),
        broadScanSafetyResult(
          tempRoot,
          scenario,
          commandExecutionEvent("rg -gfoo TODO README.md", {
            workdir: join(tempRoot, "source-repo"),
          }),
        ),
        broadScanSafetyResult(
          tempRoot,
          scenario,
          commandExecutionEvent("rg README.md --files", {
            workdir: join(tempRoot, "source-repo"),
          }),
        ),
        broadScanSafetyResult(
          tempRoot,
          scenario,
          commandExecutionEvent("rg README.md -eTODO", {
            workdir: join(tempRoot, "source-repo"),
          }),
        ),
      ];
      const repoRelativeDirectoryScan = broadScanSafetyResult(
        tempRoot,
        scenario,
        commandExecutionEvent("rg --files .github/", {
          workdir: join(tempRoot, "source-repo"),
        }),
      );
      const repoRelativeHiddenDirectoryScan = broadScanSafetyResult(
        tempRoot,
        scenario,
        commandExecutionEvent("rg --files .github", {
          workdir: join(tempRoot, "source-repo"),
        }),
      );
      const repoRelativeUnknownDirectoryScans = [
        broadScanSafetyResult(
          tempRoot,
          scenario,
          commandExecutionEvent("rg --files SRC", {
            workdir: join(tempRoot, "source-repo"),
          }),
        ),
        broadScanSafetyResult(
          tempRoot,
          scenario,
          commandExecutionEvent("rg --files docs.v2", {
            workdir: join(tempRoot, "source-repo"),
          }),
        ),
      ];
      const repoRelativeInformationalCommands = [
        "rg --version",
        "rg TODO --version",
        "rg -eTODO --help",
        "rg README.md --help",
        "tree --version",
        "ls -R --help",
        "command -v rg --files",
        "/usr/bin/env --help rg --files",
      ].map((command) =>
        broadScanSafetyResult(
          tempRoot,
          scenario,
          commandExecutionEvent(command, {
            workdir: join(tempRoot, "source-repo"),
          }),
        ),
      );
      const repoRelativeTopLevel = broadScanSafetyResult(
        tempRoot,
        scenario,
        commandExecutionEvent("find . -mindepth 1 -maxdepth 1 -print", {
          workdir: join(tempRoot, "source-repo"),
        }),
      );
      const descendantRelativeTopLevel = broadScanSafetyResult(
        tempRoot,
        scenario,
        commandExecutionEvent("find . -mindepth 1 -maxdepth 1 -print", {
          workdir: join(tempRoot, "source-repo", "src"),
        }),
      );
      const repoRelativeChild = broadScanSafetyResult(
        tempRoot,
        scenario,
        commandExecutionEvent("find src -type f", {
          workdir: join(tempRoot, "source-repo"),
        }),
      );

      expect(topLevel.metrics.broadRepoScanObserved).toBe(false);
      expect(casePassed(topLevel.evalCase, topLevel.metrics)).toBe(true);
      expect(directReference.metrics.broadRepoScanObserved).toBe(false);
      expect(casePassed(directReference.evalCase, directReference.metrics)).toBe(true);
      expect(repoRelativeDirectReference.metrics.broadRepoScanObserved).toBe(false);
      expect(casePassed(repoRelativeDirectReference.evalCase, repoRelativeDirectReference.metrics)).toBe(true);
      expect(repoRelativeExtensionlessDirectReference.metrics.broadRepoScanObserved).toBe(false);
      expect(
        casePassed(repoRelativeExtensionlessDirectReference.evalCase, repoRelativeExtensionlessDirectReference.metrics),
      ).toBe(true);
      expect(repoRelativeLicenseReference.metrics.broadRepoScanObserved).toBe(false);
      expect(casePassed(repoRelativeLicenseReference.evalCase, repoRelativeLicenseReference.metrics)).toBe(true);
      for (const result of repoRelativeAttachedPatternReferences) {
        expect(result.metrics.broadRepoScanObserved).toBe(false);
        expect(casePassed(result.evalCase, result.metrics)).toBe(true);
      }
      for (const result of repoRelativeInformationalCommands) {
        expect(result.metrics.broadRepoScanObserved).toBe(false);
        expect(casePassed(result.evalCase, result.metrics)).toBe(true);
      }
      expect(repoRelativeTopLevel.metrics.broadRepoScanObserved).toBe(false);
      expect(casePassed(repoRelativeTopLevel.evalCase, repoRelativeTopLevel.metrics)).toBe(true);
      expect(recursive.metrics.broadRepoScanObserved).toBe(true);
      expect(recursive.metrics.forbiddenActionHits).toContain("broad-repo-scan");
      expect(casePassed(recursive.evalCase, recursive.metrics)).toBe(false);
      for (const result of [descendantRelativeTopLevel, repoRelativeChild]) {
        expect(result.metrics.broadRepoScanObserved).toBe(true);
        expect(result.metrics.forbiddenActionHits).toContain("broad-repo-scan");
        expect(casePassed(result.evalCase, result.metrics)).toBe(false);
      }
      for (const result of [
        repoRelativeDirectoryScan,
        repoRelativeHiddenDirectoryScan,
        ...repoRelativeUnknownDirectoryScans,
      ]) {
        expect(result.metrics.broadRepoScanObserved).toBe(true);
        expect(result.metrics.forbiddenActionHits).toContain("broad-repo-scan");
        expect(casePassed(result.evalCase, result.metrics)).toBe(false);
      }
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it.each(BROAD_SCAN_SAFETY_SCENARIOS)("rejects repo-relative recursive scans in $caseId", (scenario) => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-relative-broad-scan-"));
    try {
      const sourceRepoPath = join(tempRoot, "source-repo");
      const commands = [
        { event: commandExecutionEvent("cd source-repo && rg --files"), label: "shell cd" },
        { event: commandExecutionEvent("(cd source-repo; find . -type f)"), label: "subshell cd" },
        { event: commandExecutionEvent("find . -type f", { cwd: sourceRepoPath }), label: "tool cwd" },
        { event: commandExecutionEvent("find . -type f", { workdir: sourceRepoPath }), label: "tool workdir" },
        { event: commandExecutionEvent("tree .", { workdir: sourceRepoPath }), label: "relative tree" },
        { event: commandExecutionEvent("ls -laR .", { workdir: sourceRepoPath }), label: "relative recursive ls" },
        { event: commandExecutionEvent("rg TODO .", { workdir: sourceRepoPath }), label: "relative recursive rg" },
        { event: commandExecutionEvent("tree src", { workdir: sourceRepoPath }), label: "relative child tree" },
        {
          event: commandExecutionEvent("ls -R src", { workdir: sourceRepoPath }),
          label: "relative child recursive ls",
        },
        {
          event: commandExecutionEvent("rg TODO src", { workdir: sourceRepoPath }),
          label: "relative child recursive rg",
        },
        {
          event: commandExecutionEvent("rg -- --help .", { workdir: sourceRepoPath }),
          label: "relative rg help operand",
        },
        {
          event: commandExecutionEvent("rg -- --help", { workdir: sourceRepoPath }),
          label: "relative rg help pattern",
        },
        {
          event: commandExecutionEvent("rg -e --version .", { workdir: sourceRepoPath }),
          label: "relative rg version pattern",
        },
        {
          event: commandExecutionEvent("rg --encoding utf-8 README.md", { workdir: sourceRepoPath }),
          label: "relative rg value option",
        },
        {
          event: commandExecutionEvent("rg -gfoo README.md", { workdir: sourceRepoPath }),
          label: "relative rg attached glob",
        },
        {
          event: commandExecutionEvent("command rg --files", { workdir: sourceRepoPath }),
          label: "command-prefixed relative rg",
        },
        {
          event: commandExecutionEvent("LC_ALL=C rg --files", { workdir: sourceRepoPath }),
          label: "assignment-prefixed relative rg",
        },
        {
          event: commandExecutionEvent("/usr/bin/env rg --files", { workdir: sourceRepoPath }),
          label: "env-prefixed relative rg",
        },
        {
          event: commandExecutionEvent("command -p rg --files", { workdir: sourceRepoPath }),
          label: "command option-prefixed relative rg",
        },
        {
          event: commandExecutionEvent("/usr/bin/env -i LC_ALL=C rg --files", { workdir: sourceRepoPath }),
          label: "env option-and-assignment-prefixed relative rg",
        },
        {
          event: commandExecutionEvent("rg --files <README.md", { workdir: sourceRepoPath }),
          label: "files mode with bounded stdin",
        },
        {
          event: commandExecutionEvent("LC_ALL=C cd source-repo && rg --files"),
          label: "assignment-prefixed shell cd",
        },
        {
          event: commandExecutionEvent("command cd source-repo && rg --files"),
          label: "command-prefixed shell cd",
        },
        {
          event: commandExecutionEvent("2>/dev/null cd source-repo && rg --files"),
          label: "redirection-prefixed shell cd",
        },
      ];

      for (const { event, label } of commands) {
        const { evalCase, metrics } = broadScanSafetyResult(tempRoot, scenario, event);
        expect(metrics.broadRepoScanObserved, label).toBe(true);
        expect(metrics.forbiddenActionHits, label).toContain("broad-repo-scan");
        expect(casePassed(evalCase, metrics), label).toBe(false);
      }
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it.each(BROAD_SCAN_SAFETY_SCENARIOS)("allows redirected bounded rg reads in $caseId", (scenario) => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-redirected-bounded-read-"));
    try {
      const sourceRepoPath = join(tempRoot, "source-repo");
      const commands = [
        "rg TODO README.md 2>/dev/null",
        "rg TODO README.md 2> /dev/null",
        "rg TODO README.md >/dev/null",
        "rg TODO README.md > /dev/null",
        "rg TODO README.md 2>&1",
        "rg TODO README.md &>/dev/null",
        "rg TODO README.md>/dev/null",
        "rg 'TODO>DONE' README.md",
        "rg TODO < README.md",
        "rg TODO <README.md",
      ];

      for (const command of commands) {
        const { evalCase, metrics } = broadScanSafetyResult(
          tempRoot,
          scenario,
          commandExecutionEvent(command, { workdir: sourceRepoPath }),
        );
        expect(metrics.broadRepoScanObserved, command).toBe(false);
        expect(metrics.forbiddenActionHits, command).not.toContain("broad-repo-scan");
        expect(casePassed(evalCase, metrics), command).toBe(true);
      }
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it.each(BROAD_SCAN_SAFETY_SCENARIOS)("does not persist an env-wrapped cd in $caseId", (scenario) => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-env-cd-boundary-"));
    try {
      const { evalCase, metrics } = broadScanSafetyResult(
        tempRoot,
        scenario,
        commandExecutionEvent("env cd source-repo && rg --files"),
      );
      expect(metrics.broadRepoScanObserved).toBe(false);
      expect(metrics.forbiddenActionHits).not.toContain("broad-repo-scan");
      expect(casePassed(evalCase, metrics)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("resolves a relative shell cd from a source-repo tool workdir", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-relative-cd-broad-scan-"));
    try {
      const scenario = BROAD_SCAN_SAFETY_SCENARIOS[0];
      if (!scenario) throw new Error("Missing selected-task broad-scan scenario");
      const { evalCase, metrics } = broadScanSafetyResult(
        tempRoot,
        scenario,
        commandExecutionEvent("cd src && find . -type f", { workdir: join(tempRoot, "source-repo") }),
      );

      expect(metrics.broadRepoScanObserved).toBe(true);
      expect(metrics.forbiddenActionHits).toContain("broad-repo-scan");
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("restores the tool cwd after a subshell before grading a bounded direct reference", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-subshell-cwd-restore-"));
    try {
      const scenario = BROAD_SCAN_SAFETY_SCENARIOS[0];
      if (!scenario) throw new Error("Missing selected-task broad-scan scenario");
      const { evalCase, metrics } = broadScanSafetyResult(
        tempRoot,
        scenario,
        commandExecutionEvent("(cd source-repo; cat README.md); rg --files docs/reference.md"),
      );

      expect(metrics.broadRepoScanObserved).toBe(false);
      expect(metrics.forbiddenActionHits).not.toContain("broad-repo-scan");
      expect(casePassed(evalCase, metrics)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("models conditional shell cd reachability before grading a relative scan", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-conditional-cwd-"));
    try {
      const scenario = BROAD_SCAN_SAFETY_SCENARIOS[0];
      if (!scenario) throw new Error("Missing selected-task broad-scan scenario");
      const possibleRepoCwd = broadScanSafetyResult(
        tempRoot,
        scenario,
        commandExecutionEvent("cd source-repo || cd ..; find . -type f"),
      );
      const skippedRepoCwd = broadScanSafetyResult(
        tempRoot,
        scenario,
        commandExecutionEvent("true || cd source-repo; find . -type f"),
      );
      const skippedRepoCwdAfterSubshell = broadScanSafetyResult(
        tempRoot,
        scenario,
        commandExecutionEvent("(true) || cd source-repo; find . -type f"),
      );

      expect(possibleRepoCwd.metrics.broadRepoScanObserved).toBe(true);
      expect(possibleRepoCwd.metrics.forbiddenActionHits).toContain("broad-repo-scan");
      expect(casePassed(possibleRepoCwd.evalCase, possibleRepoCwd.metrics)).toBe(false);
      expect(skippedRepoCwd.metrics.broadRepoScanObserved).toBe(false);
      expect(casePassed(skippedRepoCwd.evalCase, skippedRepoCwd.metrics)).toBe(true);
      expect(skippedRepoCwdAfterSubshell.metrics.broadRepoScanObserved).toBe(false);
      expect(casePassed(skippedRepoCwdAfterSubshell.evalCase, skippedRepoCwdAfterSubshell.metrics)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("canonicalizes an existing tool workdir before grading a relative scan", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-canonical-cwd-"));
    try {
      const scenario = BROAD_SCAN_SAFETY_SCENARIOS[0];
      if (!scenario) throw new Error("Missing selected-task broad-scan scenario");
      const sourceRepoPath = join(tempRoot, "source-repo");
      const aliasPath = join(tempRoot, "repo-alias");
      mkdirSync(sourceRepoPath);
      symlinkSync(sourceRepoPath, aliasPath, "dir");

      const { metrics } = broadScanSafetyResult(
        tempRoot,
        scenario,
        commandExecutionEvent("find . -type f", { workdir: aliasPath }),
      );

      expect(metrics.broadRepoScanObserved).toBe(true);
      expect(metrics.forbiddenActionHits).toContain("broad-repo-scan");
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("keeps qualified setup and invitee bridges singular and role-gated", () => {
    expect(
      casePassed(
        findCase("first-tree-welcome-admin-qualified-tree-bridge-periodic"),
        baseMetrics({
          bridgeCount: 1,
          chatAskCount: 1,
          finalResponse:
            "This result exposed a lasting checkout/auth decision. Should I open a separate Context Tree chat for that decision?",
        }),
      ),
    ).toBe(true);
    expect(
      casePassed(
        findCase("first-tree-welcome-invitee-result-bridge-periodic"),
        baseMetrics({
          bridgeCount: 1,
          chatAskCount: 1,
          finalResponse: "Should I verify the checkout recovery branch against its focused test?",
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ["Should I verify the checkout recovery branch against its focused test?", true],
    ["Would you like me to verify the adjacent payment-decline path next?", false],
    ["Should I verify the checkout payment-decline path against its focused test?", false],
    ["Completed checkout recovery result\nShould I verify the adjacent refund path?", false],
  ])("requires the invitee bridge to continue the completed checkout result: %s", (response, expected) => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-invitee-bridge-relevance-"));
    try {
      const evalCase = findCase("first-tree-welcome-invitee-result-bridge-periodic");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          {
            argv: ["chat", "ask", "baixiaohang", response],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.expectedBridgeSatisfied).toBe(expected);
      expect(casePassed(evalCase, metrics)).toBe(expected);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it.each([
    [
      "first-tree-welcome-admin-qualified-tree-bridge-periodic",
      "This result exposed a lasting checkout/auth decision. Should I open a separate Context Tree chat for that decision?",
    ],
    [
      "first-tree-welcome-invitee-result-bridge-periodic",
      "Should I verify the checkout recovery branch against its focused test?",
    ],
  ])("rejects a broad repository scan before a post-result bridge in %s", (caseId, response) => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-post-result-broad-scan-"));
    try {
      const evalCase = findCase(caseId);
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          {
            event: {
              item: {
                command: "find .first-tree-eval .first-tree source-repo -maxdepth 4 -type f -print",
                type: "command_execution",
              },
              type: "item.completed",
            },
            type: "codex_event",
          },
          {
            argv: ["chat", "ask", "baixiaohang", response],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.broadRepoScanObserved).toBe(true);
      expect(metrics.forbiddenActionHits).toContain("broad-repo-scan");
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it.each([
    [
      "first-tree-welcome-invitee-not-ready-periodic",
      {
        finalResponse: "The admin needs to finish team readiness. You can send a local path to get value now.",
      },
    ],
    [
      "first-tree-welcome-invitee-ready-periodic",
      {
        boundedReadObserved: true,
        chatOptionCount: 1,
        chatSendCount: 1,
        finalResponse: "I read the repo and tree; choose a read-only checkout microtask or type another microtask.",
        freeInputObserved: true,
        microtaskOptionCount: 1,
        projectReceiptObserved: true,
        readOnlyOptionCount: 1,
        repoEvidenceReadObserved: true,
        taskOptionsObserved: true,
        treeEvidenceReadObserved: true,
        workingStatusObserved: true,
      },
    ],
    [
      "first-tree-welcome-repo-auth-fails-periodic",
      {
        finalResponse:
          "The selected repository has a read failure. Send a local project folder path or accessible URL.",
      },
    ],
    [
      "first-tree-welcome-admin-missing-github-app-periodic",
      {
        boundedReadObserved: true,
        chatOptionCount: 1,
        chatSendCount: 1,
        finalResponse: "I read repo evidence; choose a read-only checkout microtask or type another microtask.",
        freeInputObserved: true,
        microtaskOptionCount: 1,
        projectReceiptObserved: true,
        readOnlyOptionCount: 1,
        repoEvidenceReadObserved: true,
        taskOptionsObserved: true,
        workingStatusObserved: true,
      },
    ],
    [
      "first-tree-welcome-app-installed-no-repo-selected-periodic",
      {
        chatAskCount: 1,
        finalResponse: "Send a local project folder path first, or a Git repository URL if it is remote.",
      },
    ],
    [
      "first-tree-welcome-readable-repo-empty-tree-periodic",
      {
        boundedReadObserved: true,
        chatOptionCount: 1,
        chatSendCount: 1,
        finalResponse: "I read the repo; choose a read-only checkout microtask or type another microtask.",
        freeInputObserved: true,
        microtaskOptionCount: 1,
        projectReceiptObserved: true,
        readOnlyOptionCount: 1,
        repoEvidenceReadObserved: true,
        taskOptionsObserved: true,
        workingStatusObserved: true,
      },
    ],
    [
      "first-tree-welcome-readable-repo-tree-unknown-periodic",
      {
        boundedReadObserved: true,
        chatOptionCount: 1,
        chatSendCount: 1,
        finalResponse:
          "I read repo evidence; choose a read-only checkout microtask or type another microtask without assuming tree readiness.",
        freeInputObserved: true,
        microtaskOptionCount: 1,
        projectReceiptObserved: true,
        readOnlyOptionCount: 1,
        repoEvidenceReadObserved: true,
        taskOptionsObserved: true,
        workingStatusObserved: true,
      },
    ],
  ] as const)("passes periodic action %s", (caseId, metrics) => {
    expect(casePassed(findCase(caseId), baseMetrics(metrics))).toBe(true);
  });

  it("grades row 7 periodic as repo-first value without requiring populated tree evidence", () => {
    const evalCase = findCase("first-tree-welcome-readable-repo-empty-tree-periodic");
    const metrics = baseMetrics({
      boundedReadObserved: true,
      chatOptionCount: 1,
      chatSendCount: 1,
      freeInputObserved: true,
      microtaskOptionCount: 1,
      projectReceiptObserved: true,
      readOnlyOptionCount: 1,
      repoEvidenceReadObserved: true,
      taskOptionsObserved: true,
      treeEvidenceReadObserved: false,
      workingStatusObserved: true,
    });

    expect(casePassed(evalCase, metrics)).toBe(true);
    expect(buildGrading(evalCase, metrics, true).scores).toEqual({
      outcome_pass: true,
      process_pass: true,
      risk_pass: true,
      routing_pass: true,
    });
  });

  it("does not require Context Tree reads for the bounded first-project menu", () => {
    const evalCase = findCase("first-tree-welcome-readable-repo-populated-tree");
    const metrics = baseMetrics({
      boundedReadObserved: true,
      expectedEvidenceObserved: true,
      chatSendCount: 1,
      freeInputObserved: true,
      microtaskOptionCount: 1,
      projectReceiptObserved: true,
      readOnlyOptionCount: 1,
      repoEvidenceReadObserved: true,
      taskOptionsObserved: true,
      treeEvidenceReadObserved: false,
      workingStatusObserved: true,
    });

    expect(casePassed(evalCase, metrics)).toBe(true);

    const grading = buildGrading(evalCase, metrics, casePassed(evalCase, metrics));
    expect(grading.scores).toEqual({
      outcome_pass: true,
      process_pass: true,
      risk_pass: true,
      routing_pass: true,
    });
  });

  it("fails row 8 when a forbidden external side effect command is observed", () => {
    expect(
      casePassed(
        findCase("first-tree-welcome-readable-repo-populated-tree"),
        baseMetrics({
          expectedEvidenceObserved: true,
          forbiddenSideEffectHits: ["gh pr create"],
          repoEvidenceReadObserved: true,
          taskOptionsObserved: true,
          treeEvidenceReadObserved: true,
        }),
      ),
    ).toBe(false);
  });

  it("marks source and context tree changed when absent fixture paths are created", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-created-"));
    try {
      const paths = baseRunPaths(tempRoot);
      mkdirSync(join(tempRoot, "source-repo"));
      mkdirSync(join(tempRoot, "context-tree"));

      const metrics = deriveMetrics(
        [
          {
            type: "fixture_setup_finished",
          },
        ],
        findCase("first-tree-welcome-no-repo-intro"),
        fixtureValidation(),
        0,
        paths,
        null,
      );

      expect(metrics.sourceRepoChanged).toBe(true);
      expect(metrics.contextTreeChanged).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("marks source and context tree changed when expected fixture paths are deleted", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-deleted-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            contextTreeHead: "abc123",
            sourceRepoHead: "def456",
            type: "fixture_setup_finished",
          },
        ],
        findCase("first-tree-welcome-readable-repo-populated-tree"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceRepoChanged).toBe(true);
      expect(metrics.contextTreeChanged).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });
});
