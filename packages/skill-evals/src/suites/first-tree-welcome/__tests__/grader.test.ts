import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { RunPaths } from "../../../core/types.js";
import { FIRST_TREE_WELCOME_GATE_CASES } from "../cases.js";
import { casePassed, deriveMetrics } from "../grader.js";
import { buildGrading } from "../summary.js";
import type { EvalMetrics, FirstTreeWelcomeEvalCase, FixtureValidation } from "../types.js";

function findCase(id: string): FirstTreeWelcomeEvalCase {
  const evalCase = FIRST_TREE_WELCOME_GATE_CASES.find((candidate) => candidate.id === id);
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
    repoEvidenceReadObserved: false,
    runnerExitCode: 0,
    skillFileReadObserved: true,
    sourceRepoChanged: false,
    taskOptionsObserved: false,
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

  it("passes row 3 when the model asks for a local clone path or GitHub URL without evidence claims", () => {
    expect(
      casePassed(
        findCase("first-tree-welcome-no-repo-intro"),
        baseMetrics({
          finalResponse: "Please send one local clone path or GitHub URL so I can inspect the repo first.",
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
          finalResponse: "Choose a local clone path or GitHub URL setup option.",
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
              "请发我一个项目入口：本地 clone 路径或 GitHub 仓库 URL。",
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
