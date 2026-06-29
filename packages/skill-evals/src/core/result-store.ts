import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ShippedSkillName, SkillEvalTier } from "./case-schema.js";
import { isRecord } from "./events.js";

export type ResultStoreCommand = "eval:floor" | "eval:gate" | "eval:quality";

export type ResultStoreStatus = "passed" | "failed" | "skipped";

export type ResultStoreGitInfo = {
  base: string | null;
  branch: string | null;
  sha: string | null;
};

export type ResultStoreArtifact = {
  gradingJsonPath: string | null;
  runRoot: string | null;
  summaryJsonPath: string | null;
  summaryMdPath: string | null;
};

export type ResultStoreEntry = {
  artifact: ResultStoreArtifact;
  caseId: string;
  command: ResultStoreCommand;
  costUsd: number | null;
  durationMs: number | null;
  failures: readonly string[];
  git: ResultStoreGitInfo;
  judgeScores: Record<string, number> | null;
  model: string | null;
  passed: boolean;
  provider: string | null;
  runGroupId: string;
  schemaVersion: 1;
  skill: ShippedSkillName | "framework";
  startedAt: string;
  status: ResultStoreStatus;
  tier: SkillEvalTier;
  turns: number | null;
};

export type ResultStoreRunGroup = {
  entries: readonly ResultStoreEntry[];
  runGroupId: string;
  startedAt: string;
};

export type CompareEntryDelta = {
  artifactPath: string | null;
  caseKey: string;
  costDeltaUsd: number | null;
  currentPassed: boolean;
  durationDeltaMs: number | null;
  previousPassed: boolean | null;
  scoreDeltas: Record<string, number> | null;
};

export type ResultCompareSummary = {
  currentRunGroupId: string | null;
  newFailures: readonly CompareEntryDelta[];
  previousRunGroupId: string | null;
  recovered: readonly CompareEntryDelta[];
  stillFailing: readonly CompareEntryDelta[];
  stillPassing: readonly CompareEntryDelta[];
  unchangedOrNewPassing: readonly CompareEntryDelta[];
};

export function resultStorePath(packageRoot: string): string {
  return join(packageRoot, ".runs", "index.jsonl");
}

export function sanitizeRunPart(value: string): string {
  return value.replace(/[^0-9A-Za-z_.-]/gu, "-").replace(/-+/gu, "-");
}

export function createRunGroupId(startedAt: string, label: string): string {
  const stamp = startedAt.replace(/[-:.]/gu, "");
  return `${stamp}-${sanitizeRunPart(label)}`;
}

function nullIfEmpty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function gitOutput(repoRoot: string, args: readonly string[]): string | null {
  try {
    return nullIfEmpty(
      execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return null;
  }
}

export function readGitInfo(repoRoot: string, base: string | null = null): ResultStoreGitInfo {
  return {
    base,
    branch: gitOutput(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    sha: gitOutput(repoRoot, ["rev-parse", "HEAD"]),
  };
}

export function appendResultStoreEntries(packageRoot: string, entries: readonly ResultStoreEntry[]): void {
  if (entries.length === 0) return;
  const storePath = resultStorePath(packageRoot);
  mkdirSync(dirname(storePath), { recursive: true });
  const payload = entries.map((entry) => JSON.stringify(entry)).join("\n");
  writeFileSync(storePath, `${payload}\n`, { encoding: "utf8", flag: "a" });
}

function isResultStoreEntry(value: unknown): value is ResultStoreEntry {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.runGroupId === "string" &&
    typeof value.caseId === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.passed === "boolean"
  );
}

export function readResultStore(packageRoot: string): readonly ResultStoreEntry[] {
  const storePath = resultStorePath(packageRoot);
  if (!existsSync(storePath)) return [];
  const lines = readFileSync(storePath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line, index) => {
    const parsed: unknown = JSON.parse(line);
    if (!isResultStoreEntry(parsed)) {
      throw new Error(`${storePath}:${index + 1}: invalid result store entry.`);
    }
    return parsed;
  });
}

export function groupResultEntries(entries: readonly ResultStoreEntry[]): readonly ResultStoreRunGroup[] {
  const byGroup = new Map<string, ResultStoreEntry[]>();
  for (const entry of entries) {
    const existing = byGroup.get(entry.runGroupId) ?? [];
    existing.push(entry);
    byGroup.set(entry.runGroupId, existing);
  }

  return [...byGroup.entries()]
    .map(([runGroupId, groupEntries]) => ({
      entries: groupEntries,
      runGroupId,
      startedAt: groupEntries.reduce((latest, entry) => (entry.startedAt > latest ? entry.startedAt : latest), ""),
    }))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

function caseKey(entry: ResultStoreEntry): string {
  return `${entry.skill}:${entry.tier}:${entry.caseId}`;
}

function scoreDeltas(
  current: Record<string, number> | null,
  previous: Record<string, number> | null,
): Record<string, number> | null {
  if (current === null || previous === null) return null;
  const keys = Object.keys(current).filter((key) => typeof previous[key] === "number");
  if (keys.length === 0) return null;
  return Object.fromEntries(keys.map((key) => [key, (current[key] ?? 0) - (previous[key] ?? 0)]));
}

function numericDelta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return current - previous;
}

function entryDelta(current: ResultStoreEntry, previous: ResultStoreEntry | null): CompareEntryDelta {
  return {
    artifactPath: current.artifact.gradingJsonPath ?? current.artifact.summaryJsonPath ?? current.artifact.runRoot,
    caseKey: caseKey(current),
    costDeltaUsd: numericDelta(current.costUsd, previous?.costUsd ?? null),
    currentPassed: current.passed,
    durationDeltaMs: numericDelta(current.durationMs, previous?.durationMs ?? null),
    previousPassed: previous?.passed ?? null,
    scoreDeltas: scoreDeltas(current.judgeScores, previous?.judgeScores ?? null),
  };
}

export function compareResultGroups(
  current: ResultStoreRunGroup | null,
  previous: ResultStoreRunGroup | null,
): ResultCompareSummary {
  if (current === null || previous === null) {
    return {
      currentRunGroupId: current?.runGroupId ?? null,
      newFailures: [],
      previousRunGroupId: previous?.runGroupId ?? null,
      recovered: [],
      stillFailing: [],
      stillPassing: [],
      unchangedOrNewPassing: [],
    };
  }

  const previousByKey = new Map(previous.entries.map((entry) => [caseKey(entry), entry]));
  const newFailures: CompareEntryDelta[] = [];
  const recovered: CompareEntryDelta[] = [];
  const stillFailing: CompareEntryDelta[] = [];
  const stillPassing: CompareEntryDelta[] = [];
  const unchangedOrNewPassing: CompareEntryDelta[] = [];

  for (const currentEntry of current.entries) {
    const previousEntry = previousByKey.get(caseKey(currentEntry)) ?? null;
    const delta = entryDelta(currentEntry, previousEntry);
    if (!currentEntry.passed && previousEntry?.passed !== false) {
      newFailures.push(delta);
    } else if (currentEntry.passed && previousEntry?.passed === false) {
      recovered.push(delta);
    } else if (!currentEntry.passed && previousEntry?.passed === false) {
      stillFailing.push(delta);
    } else if (currentEntry.passed && previousEntry?.passed === true) {
      stillPassing.push(delta);
    } else {
      unchangedOrNewPassing.push(delta);
    }
  }

  return {
    currentRunGroupId: current.runGroupId,
    newFailures,
    previousRunGroupId: previous.runGroupId,
    recovered,
    stillFailing,
    stillPassing,
    unchangedOrNewPassing,
  };
}

export function latestRunGroups(
  entries: readonly ResultStoreEntry[],
  currentRunGroupId: string | null,
  previousRunGroupId: string | null,
): { current: ResultStoreRunGroup | null; previous: ResultStoreRunGroup | null } {
  const groups = groupResultEntries(entries);
  const byId = new Map(groups.map((group) => [group.runGroupId, group]));
  const current =
    currentRunGroupId === null ? (groups[groups.length - 1] ?? null) : (byId.get(currentRunGroupId) ?? null);
  const previous =
    previousRunGroupId === null
      ? current === null
        ? null
        : (groups
            .filter((group) => group.runGroupId !== current.runGroupId)
            .filter((group) => groupsHaveSharedCaseKeys(current, group))
            .at(-1) ?? null)
      : (byId.get(previousRunGroupId) ?? null);
  return { current, previous };
}

function groupsHaveSharedCaseKeys(left: ResultStoreRunGroup, right: ResultStoreRunGroup): boolean {
  const rightKeys = new Set(right.entries.map(caseKey));
  return left.entries.some((entry) => rightKeys.has(caseKey(entry)));
}

function formatDeltaList(title: string, deltas: readonly CompareEntryDelta[]): readonly string[] {
  const lines = [`${title}: ${deltas.length}`];
  for (const delta of deltas) {
    const duration =
      delta.durationDeltaMs === null
        ? ""
        : ` duration_delta_ms=${delta.durationDeltaMs >= 0 ? "+" : ""}${delta.durationDeltaMs}`;
    const cost =
      delta.costDeltaUsd === null ? "" : ` cost_delta_usd=${delta.costDeltaUsd >= 0 ? "+" : ""}${delta.costDeltaUsd}`;
    lines.push(`- ${delta.caseKey}${duration}${cost}`);
    if (delta.scoreDeltas !== null) {
      const scoreText = Object.entries(delta.scoreDeltas)
        .map(([key, value]) => `${key}=${value >= 0 ? "+" : ""}${value}`)
        .join(", ");
      lines.push(`  score_delta: ${scoreText}`);
    }
    if (delta.artifactPath !== null) {
      lines.push(`  artifact: ${delta.artifactPath}`);
    }
  }
  return lines;
}

export function formatCompareSummary(summary: ResultCompareSummary): string {
  if (summary.currentRunGroupId === null || summary.previousRunGroupId === null) {
    return [
      "Skill Eval Compare",
      "",
      "Not enough eval run groups to compare.",
      "Run at least two eval commands that write result-store entries, or pass explicit run group ids.",
    ].join("\n");
  }

  return [
    "Skill Eval Compare",
    "",
    `Current: ${summary.currentRunGroupId}`,
    `Previous: ${summary.previousRunGroupId}`,
    "",
    ...formatDeltaList("New failures", summary.newFailures),
    "",
    ...formatDeltaList("Recovered", summary.recovered),
    "",
    ...formatDeltaList("Still failing", summary.stillFailing),
    "",
    ...formatDeltaList("Still passing", summary.stillPassing),
    "",
    ...formatDeltaList("New or unchanged passing", summary.unchangedOrNewPassing),
  ].join("\n");
}
