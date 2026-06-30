import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendResultStoreEntries,
  compareResultGroups,
  createRunGroupId,
  formatResultRunSummary,
  groupResultEntries,
  latestRunGroups,
  type ResultStoreEntry,
  readResultStore,
  summarizeResultRunGroup,
} from "../result-store.js";

function tempPackageRoot(): string {
  return mkdtempSync(join(tmpdir(), "skill-evals-result-store-test-"));
}

function entry(overrides: Partial<ResultStoreEntry> = {}): ResultStoreEntry {
  return {
    artifact: {
      gradingJsonPath: "/tmp/run/grading.json",
      runRoot: "/tmp/run",
      summaryJsonPath: "/tmp/run/summary.json",
      summaryMdPath: "/tmp/run/summary.md",
    },
    caseId: "durable-source-writes",
    command: "eval:gate",
    costUsd: null,
    durationMs: null,
    firstResponseLatencyMs: null,
    failures: [],
    git: {
      base: null,
      branch: "feat/test",
      sha: "abc123",
    },
    judgeScores: null,
    model: "gpt-test",
    passed: true,
    provider: "codex",
    runGroupId: "20260629T010000000Z-eval-gate",
    schemaVersion: 1,
    skill: "first-tree-write",
    startedAt: "2026-06-29T01:00:00.000Z",
    status: "passed",
    tier: "gate",
    turns: null,
    ...overrides,
  };
}

describe("result store", () => {
  it("appends and reads JSONL entries under .runs", () => {
    const packageRoot = tempPackageRoot();
    try {
      appendResultStoreEntries(packageRoot, [entry()]);

      const entries = readResultStore(packageRoot);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.caseId).toBe("durable-source-writes");
      expect(entries[0]?.artifact.gradingJsonPath).toBe("/tmp/run/grading.json");
      expect(entries[0]?.artifact.summaryJsonPath).toBe("/tmp/run/summary.json");
    } finally {
      rmSync(packageRoot, { force: true, recursive: true });
    }
  });

  it("groups latest and previous run groups and compares pass/fail transitions", () => {
    const previous = entry({
      passed: true,
      runGroupId: "20260629T010000000Z-eval-gate",
      startedAt: "2026-06-29T01:00:00.000Z",
    });
    const currentFailure = entry({
      failures: ["expected diff missing"],
      passed: false,
      runGroupId: "20260629T020000000Z-eval-gate",
      startedAt: "2026-06-29T02:00:00.000Z",
      status: "failed",
    });
    const recoveredPrevious = entry({
      caseId: "first-tree-welcome-first-task-quality",
      command: "eval:quality",
      judgeScores: {
        bounded: 3,
        useful: 2,
      },
      passed: false,
      runGroupId: "20260629T010000000Z-eval-gate",
      skill: "first-tree-welcome",
      startedAt: "2026-06-29T01:00:00.000Z",
      status: "failed",
      tier: "quality",
    });
    const recoveredCurrent = entry({
      caseId: "first-tree-welcome-first-task-quality",
      command: "eval:quality",
      judgeScores: {
        bounded: 5,
        useful: 4,
      },
      passed: true,
      runGroupId: "20260629T020000000Z-eval-gate",
      skill: "first-tree-welcome",
      startedAt: "2026-06-29T02:00:00.000Z",
      tier: "quality",
    });

    const groups = groupResultEntries([previous, currentFailure, recoveredPrevious, recoveredCurrent]);
    const { current, previous: selectedPrevious } = latestRunGroups(
      [previous, currentFailure, recoveredPrevious, recoveredCurrent],
      null,
      null,
    );
    const comparison = compareResultGroups(current, selectedPrevious);

    expect(groups.map((group) => group.runGroupId)).toEqual([
      "20260629T010000000Z-eval-gate",
      "20260629T020000000Z-eval-gate",
    ]);
    expect(comparison.newFailures.map((delta) => delta.caseKey)).toEqual([
      "first-tree-write:gate:durable-source-writes",
    ]);
    expect(comparison.recovered.map((delta) => delta.caseKey)).toEqual([
      "first-tree-welcome:quality:first-tree-welcome-first-task-quality",
    ]);
    expect(comparison.recovered[0]?.scoreDeltas).toEqual({
      bounded: 2,
      useful: 2,
    });
  });

  it("creates stable run group ids from timestamps and labels", () => {
    expect(createRunGroupId("2026-06-29T02:00:00.000Z", "eval:gate first-tree-write")).toBe(
      "20260629T020000000Z-eval-gate-first-tree-write",
    );
  });

  it("summarizes the latest run group with observability and lightweight flaky status", () => {
    const previous = entry({
      runGroupId: "20260629T010000000Z-eval-gate",
      startedAt: "2026-06-29T01:00:00.000Z",
    });
    const currentFailure = entry({
      durationMs: 1200,
      failures: ["outcome_pass: expected response missing"],
      firstResponseLatencyMs: 350,
      passed: false,
      runGroupId: "20260629T020000000Z-eval-gate",
      startedAt: "2026-06-29T02:00:00.000Z",
      status: "failed",
      turns: 1,
    });
    const currentQuality = entry({
      artifact: {
        gradingJsonPath: null,
        runRoot: "/tmp/quality-run",
        summaryJsonPath: "/tmp/quality-run/summary.json",
        summaryMdPath: "/tmp/quality-run/summary.md",
      },
      caseId: "first-tree-welcome-first-task-quality",
      command: "eval:quality",
      durationMs: 200,
      judgeScores: {
        bounded: 4,
        useful: 3,
      },
      passed: true,
      runGroupId: "20260629T020000000Z-eval-gate",
      skill: "first-tree-welcome",
      startedAt: "2026-06-29T02:00:01.000Z",
      tier: "quality",
    });

    const summary = summarizeResultRunGroup([previous, currentFailure, currentQuality], null);

    expect(summary?.runGroupId).toBe("20260629T020000000Z-eval-gate");
    expect(summary?.failed).toBe(1);
    expect(summary?.totalDurationMs).toBe(1400);
    expect(summary?.turns).toBe(1);
    expect(summary?.firstResponseLatencyMs).toBe(350);
    expect(summary?.git).toEqual({
      base: null,
      branch: "feat/test",
      sha: "abc123",
    });
    expect(summary?.countsByCommand).toEqual({
      "eval:gate": 1,
      "eval:quality": 1,
    });
    expect(summary?.countsBySkill).toEqual({
      "first-tree-welcome": 1,
      "first-tree-write": 1,
    });
    expect(summary?.countsByTier).toEqual({
      gate: 1,
      quality: 1,
    });
    expect(summary?.entries.find((candidate) => candidate.tier === "quality")?.judgeScores).toEqual({
      bounded: 4,
      useful: 3,
    });
    expect(summary?.flaky).toMatchObject({
      newFailures: 1,
      previousRunGroupId: "20260629T010000000Z-eval-gate",
      status: "status-flips",
    });
    const formatted = formatResultRunSummary(summary);
    expect(formatted).toContain("Git: branch=feat/test sha=abc123 base=n/a");
    expect(formatted).toContain("Counts by command: eval:gate=1, eval:quality=1");
    expect(formatted).toContain("Counts by tier: gate=1, quality=1");
    expect(formatted).toContain("Counts by skill: first-tree-welcome=1, first-tree-write=1");
    expect(formatted).toContain("First response latency: 350 ms");
    expect(formatted).toContain("judge_scores: bounded=4, useful=3");
  });

  it("returns null when there are no result-store run groups to summarize", () => {
    expect(summarizeResultRunGroup([], null)).toBeNull();
    expect(formatResultRunSummary(null)).toContain("No result-store run groups found.");
  });
});
