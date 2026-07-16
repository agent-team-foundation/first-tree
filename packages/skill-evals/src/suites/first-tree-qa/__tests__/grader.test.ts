import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertCommandOk, runCommand, writeText } from "../../../core/commands.js";
import { appendEvent, readEvents } from "../../../core/events.js";
import { createRunPaths } from "../../../core/paths.js";
import { createEvalReporter } from "../../../core/reporter.js";
import { FIRST_TREE_QA_LIVE_GATE_CASES } from "../cases.js";
import { setupFixture, validateFixture } from "../fixture.js";
import { casePassed, deriveMetrics } from "../grader.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function evalCase(id: string) {
  const found = FIRST_TREE_QA_LIVE_GATE_CASES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing eval case ${id}`);
  return found;
}

function setup(id: string) {
  const root = mkdtempSync(join(tmpdir(), "first-tree-qa-eval-"));
  tempRoots.push(root);
  const packageRoot = join(root, "packages", "skill-evals");
  mkdirSync(packageRoot, { recursive: true });
  writeText(
    join(root, "skills", "first-tree-qa", "SKILL.md"),
    [
      "---",
      "name: first-tree-qa",
      "description: Test a complete product harness before task execution.",
      "---",
      "",
      "# First Tree QA",
      "",
    ].join("\n"),
  );
  const currentCase = evalCase(id);
  const paths = createRunPaths({ caseId: id, packageRoot, startedAt: "2026-07-16T00:00:00.000Z" });
  const sourceRepoPath = setupFixture(currentCase, paths, createEvalReporter(id, false));
  return { currentCase, paths, sourceRepoPath };
}

function runAllCapabilities(sourceRepoPath: string): void {
  for (const surface of ["cli", "web"]) {
    for (const capability of ["build", "run", "drive", "observe", "measure", "reset"]) {
      const result = runCommand(
        process.execPath,
        ["tools/product.mjs", "harness", surface, capability],
        sourceRepoPath,
      );
      if (!(surface === "web" && capability === "observe" && result.exitCode === 42)) {
        assertCommandOk(result);
      }
    }
  }
}

function appendModelEvidence(paths: ReturnType<typeof createRunPaths>, finalText: string): void {
  appendEvent(paths.eventsPath, {
    event: {
      item: {
        command: "sed -n 1,200p .agents/skills/first-tree-qa/SKILL.md",
        type: "command_execution",
      },
      type: "item.completed",
    },
    type: "codex_event",
  });
  appendEvent(paths.eventsPath, {
    event: {
      item: { text: finalText, type: "agent_message" },
      type: "item.completed",
    },
    type: "codex_event",
  });
}

describe("first-tree-qa deterministic grader", () => {
  it("passes a complete readiness matrix followed by plan and real CLI behavior", () => {
    const { currentCase, paths, sourceRepoPath } = setup("first-tree-qa-ready-then-scope");
    assertCommandOk(runCommand(process.execPath, ["--test"], sourceRepoPath));
    expect(existsSync(join(paths.workspacePath, "qa-artifacts", "product-events.jsonl"))).toBe(false);
    runAllCapabilities(sourceRepoPath);
    writeText(join(paths.workspacePath, "qa-artifacts", "run-context.md"), "# Run Context\n");
    writeText(join(paths.workspacePath, "qa-artifacts", "plan.md"), "# QA Plan\n");
    const task = spawnSync(process.execPath, ["tools/product.mjs", "task", "cli", "status"], {
      cwd: sourceRepoPath,
      encoding: "utf8",
      env: {
        ...process.env,
        NORTHSTAR_EVENT_PATH: join(paths.workspacePath, "qa-artifacts", "status-events.jsonl"),
      },
    });
    expect(task.status).toBe(0);
    writeText(
      join(paths.workspacePath, "qa-artifacts", "report.md"),
      [
        "# QA Report",
        "Status: PASS",
        "Evidence: product-events.jsonl and Northstar CLI status healthy (jobs=3).",
        "Performance: latency 17 ms.",
        "Case disposition: no-change.",
      ].join("\n"),
    );
    appendModelEvidence(paths, "PASS. Evidence and report are in qa-artifacts. Case disposition: no-change.");

    const validation = validateFixture(paths, sourceRepoPath);
    const metrics = deriveMetrics(readEvents(paths.eventsPath), currentCase, validation, 0, paths);

    expect(metrics.readinessComplete).toBe(true);
    expect(metrics.planAfterReadiness).toBe(true);
    expect(metrics.taskAfterPlan).toBe(true);
    expect(metrics.sourceRepoChanged).toBe(false);
    expect(casePassed(currentCase, metrics)).toBe(true);
  });

  it("passes a blocked readiness matrix without planning or task execution", () => {
    const { currentCase, paths, sourceRepoPath } = setup("first-tree-qa-readiness-blocked");
    runAllCapabilities(sourceRepoPath);
    writeText(join(paths.workspacePath, "qa-artifacts", "run-context.md"), "# Run Context\n");
    writeText(
      join(paths.workspacePath, "qa-artifacts", "report.md"),
      [
        "# QA Report",
        "Status: BLOCKED",
        "Evidence: product-events.jsonl records web:observe as unavailable.",
        "Performance: CLI latency 17 ms; Web latency 29 ms.",
        "Case disposition: no-change.",
      ].join("\n"),
    );
    appendModelEvidence(paths, "BLOCKED. Web observer unavailable. Case disposition: no-change.");

    const validation = validateFixture(paths, sourceRepoPath);
    const metrics = deriveMetrics(readEvents(paths.eventsPath), currentCase, validation, 0, paths);

    expect(metrics.attemptedCapabilities).toHaveLength(12);
    expect(metrics.failedCapabilities).toEqual(["web:observe"]);
    expect(metrics.planExists).toBe(false);
    expect(metrics.taskRan).toBe(false);
    expect(metrics.sourceRepoChanged).toBe(false);
    expect(casePassed(currentCase, metrics)).toBe(true);
  });
});
