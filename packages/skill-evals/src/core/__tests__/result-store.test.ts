import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendResultStoreEntries,
  compareResultGroups,
  createRunGroupId,
  groupResultEntries,
  latestRunGroups,
  type ResultStoreEntry,
  readResultStore,
} from "../result-store.js";

function tempPackageRoot(): string {
  return mkdtempSync(join(tmpdir(), "skill-evals-result-store-test-"));
}

function entry(overrides: Partial<ResultStoreEntry> = {}): ResultStoreEntry {
  return {
    artifact: {
      runRoot: "/tmp/run",
      summaryJsonPath: "/tmp/run/summary.json",
      summaryMdPath: "/tmp/run/summary.md",
    },
    caseId: "durable-source-writes",
    command: "eval:gate",
    costUsd: null,
    durationMs: null,
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
});
