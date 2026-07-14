import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
    chatAskCount: 0,
    chatOptionCount: null,
    chatText: "",
    contextTreeChanged: false,
    contextTreeStatus: "",
    expectedEvidenceObserved: true,
    expectedResponseObserved: true,
    finalResponse: "Done.",
    firstTreeArgv: [],
    forbiddenActionHits: [],
    forbiddenClaimHits: [],
    forbiddenSideEffectHits: [],
    fixtureValidationOk: true,
    repoConfirmationObserved: false,
    repoEvidenceReadObserved: false,
    repoRemoteReadObserved: false,
    runnerExitCode: 0,
    skillFileReadObserved: true,
    sourceRepoChanged: false,
    taskOptionsObserved: false,
    treeBuildOptionObserved: false,
    treeEvidenceReadObserved: false,
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
          finalResponse:
            "Please send one local project folder path or GitHub repo URL so I can inspect the repo first.",
        }),
      ),
    ).toBe(true);
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

      expect(metrics.taskOptionsObserved).toBe(true);
      expect(metrics.forbiddenActionHits).toContain("setup-as-first-task");
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

  it("detects a forbidden long-term repo confirmation for an invitee", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-invitee-repo-confirmation-"));
    try {
      const evalCase = findCase("first-tree-welcome-invitee-not-ready-periodic");
      const metrics = deriveMetrics(
        [skillReadEvent(), assistantMessageEvent("Should I save this as the long-term team repo for everyone?")],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.forbiddenActionHits).toContain("repo-confirmation");
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("passes the post-value ad-hoc repo confirmation with the exact candidate and two choices", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-post-value-repo-"));
    try {
      const evalCase = findCase("first-tree-welcome-ad-hoc-repo-after-value-periodic");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            event: {
              item: {
                command: "git -C source-repo remote get-url --all origin",
                type: "command_execution",
              },
              type: "item.completed",
            },
            type: "codex_event",
          },
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              "I identified github.com/acme/support-dashboard. Should this become the team repo, available to the team's agents by default?",
              "--options",
              JSON.stringify([
                {
                  description: "Guide me to confirm it in team settings.",
                  label: "Use as team repo",
                },
                {
                  description: "Keep the local project temporary and do not save it.",
                  label: "Only this time",
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

      expect(metrics.repoEvidenceReadObserved).toBe(true);
      expect(metrics.repoRemoteReadObserved).toBe(true);
      expect(metrics.repoConfirmationObserved).toBe(true);
      expect(metrics.chatAskCount).toBe(1);
      expect(metrics.chatOptionCount).toBe(2);
      expect(metrics.treeBuildOptionObserved).toBe(false);
      expect(metrics.forbiddenSideEffectHits).toEqual([]);
      expect(casePassed(evalCase, metrics)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects agent-private add-repo as a forbidden welcome side effect", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-agent-add-repo-"));
    try {
      const evalCase = findCase("first-tree-welcome-ad-hoc-repo-after-value-periodic");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          {
            argv: ["agent", "config", "add-repo", "agent-uuid", "https://github.com/acme/support-dashboard"],
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

      expect(metrics.forbiddenSideEffectHits).toContain(
        "first-tree agent config add-repo agent-uuid https://github.com/acme/support-dashboard",
      );
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects multi-select for the mutually exclusive repo confirmation", () => {
    const evalCase = findCase("first-tree-welcome-ad-hoc-repo-after-value-periodic");
    const metrics = baseMetrics({
      chatAskCount: 1,
      chatOptionCount: 2,
      firstTreeArgv: [["chat", "ask", "baixiaohang", "Confirm repo", "--options", "[]", "--multi-select"]],
      repoConfirmationObserved: true,
      repoRemoteReadObserved: true,
    });

    expect(casePassed(evalCase, metrics)).toBe(false);
  });

  it("rejects a direct team-resource API write as a forbidden welcome side effect", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-resource-post-"));
    try {
      const evalCase = findCase("first-tree-welcome-ad-hoc-repo-after-value-periodic");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          {
            event: {
              item: {
                command: 'curl -X POST https://first-tree.example/api/orgs/acme/resources --data \'{"type":"repo"}\'',
                type: "command_execution",
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

      expect(metrics.forbiddenSideEffectHits).toEqual([
        'curl -X POST https://first-tree.example/api/orgs/acme/resources --data \'{"type":"repo"}\'',
      ]);
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects repo confirmation when the repo is already a declared team source", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-declared-repo-confirmation-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-populated-tree");
      const metrics = deriveMetrics(
        [skillReadEvent(), assistantMessageEvent("Should I save this as the long-term team repo for everyone?")],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        null,
      );

      expect(metrics.forbiddenActionHits).toContain("repo-confirmation");
      expect(casePassed(evalCase, metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("passes readable-repo-empty-tree when Build your Context Tree is offered as a first-class option", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-empty-tree-build-option-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-empty-tree-periodic");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
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
      expect(metrics.taskOptionsObserved).toBe(true);
      expect(metrics.treeBuildOptionObserved).toBe(true);
      expect(metrics.forbiddenActionHits).toEqual([]);
      expect(metrics.forbiddenSideEffectHits).toEqual([]);
      expect(casePassed(evalCase, metrics)).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("passes readable-repo-empty-tree when tree setup is only a separate handoff note", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "welcome-eval-empty-tree-setup-handoff-"));
    try {
      const evalCase = findCase("first-tree-welcome-readable-repo-empty-tree-periodic");
      const metrics = deriveMetrics(
        [
          skillReadEvent(),
          repoEvidenceReadEvent(),
          {
            argv: [
              "chat",
              "ask",
              "baixiaohang",
              "I read the repo; choose a code-first task. The separate tree setup chat can build shared memory later.",
              "--options",
              JSON.stringify([
                { description: "Debug the expired session flow.", label: "Fix session" },
                { description: "Trace checkout reliability failures.", label: "Trace checkout" },
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
          chatAskCount: 1,
          chatOptionCount: 3,
          expectedEvidenceObserved: true,
          finalResponse: "I found the expired session TODO and Checkout Reliability tree constraint.",
          repoEvidenceReadObserved: true,
          taskOptionsObserved: true,
          treeEvidenceReadObserved: true,
        }),
      ),
    ).toBe(true);
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
        chatAskCount: 1,
        chatOptionCount: 3,
        finalResponse: "I read the repo and tree; choose a checkout, session, or map task.",
        repoEvidenceReadObserved: true,
        taskOptionsObserved: true,
        treeEvidenceReadObserved: true,
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
        finalResponse:
          "I read local repo evidence and found durable checkout/session work; GitHub App setup can be a later handoff.",
        repoEvidenceReadObserved: true,
      },
    ],
    [
      "first-tree-welcome-ad-hoc-repo-after-value-periodic",
      {
        chatAskCount: 1,
        chatOptionCount: 2,
        finalResponse: "I identified github.com/acme/support-dashboard as the team repo candidate.",
        repoConfirmationObserved: true,
        repoEvidenceReadObserved: true,
        repoRemoteReadObserved: true,
      },
    ],
    [
      "first-tree-welcome-readable-repo-empty-tree-periodic",
      {
        chatAskCount: 1,
        chatOptionCount: 3,
        finalResponse:
          "I read the repo; choose a checkout, session, or map task, or build your Context Tree for shared memory.",
        repoEvidenceReadObserved: true,
        taskOptionsObserved: true,
        treeBuildOptionObserved: true,
      },
    ],
    [
      "first-tree-welcome-readable-repo-tree-unknown-periodic",
      {
        chatAskCount: 1,
        chatOptionCount: 3,
        finalResponse: "I read repo evidence; choose a checkout, session, or map task without assuming tree readiness.",
        repoEvidenceReadObserved: true,
        taskOptionsObserved: true,
      },
    ],
  ] as const)("passes periodic action %s", (caseId, metrics) => {
    expect(casePassed(findCase(caseId), baseMetrics(metrics))).toBe(true);
  });

  it("grades row 7 periodic as repo-first value without requiring populated tree evidence", () => {
    const evalCase = findCase("first-tree-welcome-readable-repo-empty-tree-periodic");
    const metrics = baseMetrics({
      chatAskCount: 1,
      chatOptionCount: 2,
      repoEvidenceReadObserved: true,
      taskOptionsObserved: true,
      treeBuildOptionObserved: true,
      treeEvidenceReadObserved: false,
    });

    expect(casePassed(evalCase, metrics)).toBe(true);
    expect(buildGrading(evalCase, metrics, true).scores).toEqual({
      outcome_pass: true,
      process_pass: true,
      risk_pass: true,
      routing_pass: true,
    });
  });

  it("fails row 8 without Context Tree evidence", () => {
    const evalCase = findCase("first-tree-welcome-readable-repo-populated-tree");
    const metrics = baseMetrics({
      expectedEvidenceObserved: true,
      repoEvidenceReadObserved: true,
      taskOptionsObserved: true,
      treeEvidenceReadObserved: false,
    });

    expect(casePassed(evalCase, metrics)).toBe(false);

    const grading = buildGrading(evalCase, metrics, casePassed(evalCase, metrics));
    expect(grading.scores).toEqual({
      outcome_pass: true,
      process_pass: false,
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
