import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ShippedSkillName, SkillEvalTier } from "./case-schema.js";
import { isRecord } from "./events.js";

export type ResultStoreCommand = "eval:floor" | "eval:gate" | "eval:periodic" | "eval:quality";

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
  firstResponseLatencyMs: number | null;
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

export type ResultRunFailure = {
  artifactPath: string | null;
  caseKey: string;
  failures: readonly string[];
};

export type ResultRunFlakySummary = {
  newFailures: number;
  previousRunGroupId: string | null;
  recovered: number;
  status: "not-enough-history" | "stable" | "status-flips";
};

export type ResultRunEntrySummary = {
  artifactPath: string | null;
  caseKey: string;
  command: ResultStoreCommand;
  durationMs: number | null;
  failures: readonly string[];
  firstResponseLatencyMs: number | null;
  git: ResultStoreGitInfo;
  judgeScores: Record<string, number> | null;
  passed: boolean;
  skill: ShippedSkillName | "framework";
  status: ResultStoreStatus;
  tier: SkillEvalTier;
  turns: number | null;
};

export type ResultRunSummary = {
  countsByCommand: Record<string, number>;
  countsBySkill: Record<string, number>;
  countsByTier: Record<string, number>;
  entries: readonly ResultRunEntrySummary[];
  failed: number;
  failures: readonly ResultRunFailure[];
  firstResponseLatencyMs: number | null;
  flaky: ResultRunFlakySummary;
  git: ResultStoreGitInfo | null;
  passed: number;
  runGroupId: string;
  skipped: number;
  startedAt: string;
  total: number;
  totalDurationMs: number | null;
  turns: number | null;
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

function artifactPath(entry: ResultStoreEntry): string | null {
  return entry.artifact.gradingJsonPath ?? entry.artifact.summaryJsonPath ?? entry.artifact.runRoot;
}

function sumKnown(values: readonly (number | null | undefined)[]): number | null {
  const known = values.filter((value) => typeof value === "number");
  if (known.length === 0) return null;
  return known.reduce((total, value) => total + value, 0);
}

function minKnown(values: readonly (number | null | undefined)[]): number | null {
  const known = values.filter((value) => typeof value === "number");
  if (known.length === 0) return null;
  return Math.min(...known);
}

function countBy(
  entries: readonly ResultStoreEntry[],
  keyFor: (entry: ResultStoreEntry) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const key = keyFor(entry);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function previousComparableGroup(
  current: ResultStoreRunGroup,
  groups: readonly ResultStoreRunGroup[],
): ResultStoreRunGroup | null {
  return (
    groups
      .filter((group) => group.runGroupId !== current.runGroupId)
      .filter((group) => group.startedAt < current.startedAt)
      .filter((group) => groupsHaveSharedCaseKeys(current, group))
      .at(-1) ?? null
  );
}

export function summarizeResultRunGroup(
  entries: readonly ResultStoreEntry[],
  currentRunGroupId: string | null,
): ResultRunSummary | null {
  const groups = groupResultEntries(entries);
  const current =
    currentRunGroupId === null
      ? (groups.at(-1) ?? null)
      : (groups.find((group) => group.runGroupId === currentRunGroupId) ?? null);
  if (current === null) return null;

  const previous = previousComparableGroup(current, groups);
  const comparison = compareResultGroups(current, previous);
  const passed = current.entries.filter((entry) => entry.status === "passed").length;
  const failed = current.entries.filter((entry) => entry.status === "failed").length;
  const skipped = current.entries.filter((entry) => entry.status === "skipped").length;
  const firstResponseLatencyMs = minKnown(current.entries.map((entry) => entry.firstResponseLatencyMs));
  const turns = sumKnown(current.entries.map((entry) => entry.turns));

  return {
    countsByCommand: countBy(current.entries, (entry) => entry.command),
    countsBySkill: countBy(current.entries, (entry) => entry.skill),
    countsByTier: countBy(current.entries, (entry) => entry.tier),
    entries: current.entries.map((entry) => ({
      artifactPath: artifactPath(entry),
      caseKey: caseKey(entry),
      command: entry.command,
      durationMs: entry.durationMs,
      failures: entry.failures,
      firstResponseLatencyMs: entry.firstResponseLatencyMs ?? null,
      git: entry.git,
      judgeScores: entry.judgeScores,
      passed: entry.passed,
      skill: entry.skill,
      status: entry.status,
      tier: entry.tier,
      turns: entry.turns ?? null,
    })),
    failed,
    failures: current.entries
      .filter((entry) => entry.failures.length > 0)
      .map((entry) => ({
        artifactPath: artifactPath(entry),
        caseKey: caseKey(entry),
        failures: entry.failures,
      })),
    firstResponseLatencyMs,
    flaky: {
      newFailures: comparison.newFailures.length,
      previousRunGroupId: previous?.runGroupId ?? null,
      recovered: comparison.recovered.length,
      status:
        previous === null
          ? "not-enough-history"
          : comparison.newFailures.length + comparison.recovered.length > 0
            ? "status-flips"
            : "stable",
    },
    git: current.entries[0]?.git ?? null,
    passed,
    runGroupId: current.runGroupId,
    skipped,
    startedAt: current.startedAt,
    total: current.entries.length,
    totalDurationMs: sumKnown(current.entries.map((entry) => entry.durationMs)),
    turns,
  };
}

function formatNullableMs(value: number | null): string {
  return value === null ? "n/a" : `${value} ms`;
}

function formatNullableNumber(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function formatNullableText(value: string | null): string {
  return value === null ? "n/a" : value;
}

function formatCountMap(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "none";
  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

function formatJudgeScores(scores: Record<string, number> | null): string | null {
  if (scores === null) return null;
  return Object.entries(scores)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function formatFlaky(summary: ResultRunFlakySummary): string {
  if (summary.status === "not-enough-history") {
    return "not enough comparable history";
  }
  const prefix = summary.status === "stable" ? "stable" : "status flips";
  return `${prefix} vs ${summary.previousRunGroupId}: new_failures=${summary.newFailures}, recovered=${summary.recovered}`;
}

export function formatResultRunSummary(summary: ResultRunSummary | null): string {
  if (summary === null) {
    return ["Skill Eval Summary", "", "No result-store run groups found."].join("\n");
  }

  const failureLines =
    summary.failures.length === 0
      ? ["Failures: 0"]
      : [
          `Failures: ${summary.failures.length}`,
          ...summary.failures.flatMap((failure) => [
            `- ${failure.caseKey}: ${failure.failures.join("; ")}`,
            ...(failure.artifactPath === null ? [] : [`  artifact: ${failure.artifactPath}`]),
          ]),
        ];
  const entryLines = summary.entries.flatMap((entry) => {
    const artifact = entry.artifactPath === null ? "" : ` artifact=${entry.artifactPath}`;
    const scores = formatJudgeScores(entry.judgeScores);
    return [
      `- ${entry.status.toUpperCase()} ${entry.caseKey} command=${entry.command} tier=${entry.tier} skill=${
        entry.skill
      } duration_ms=${formatNullableNumber(entry.durationMs)} turns=${formatNullableNumber(
        entry.turns,
      )} first_response_latency_ms=${formatNullableNumber(entry.firstResponseLatencyMs)}${artifact}`,
      ...(scores === null ? [] : [`  judge_scores: ${scores}`]),
    ];
  });

  return [
    "Skill Eval Summary",
    "",
    `Run group: ${summary.runGroupId}`,
    `Started: ${summary.startedAt}`,
    `Git: branch=${formatNullableText(summary.git?.branch ?? null)} sha=${formatNullableText(
      summary.git?.sha ?? null,
    )} base=${formatNullableText(summary.git?.base ?? null)}`,
    `Entries: ${summary.total} total, ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`,
    `Counts by command: ${formatCountMap(summary.countsByCommand)}`,
    `Counts by tier: ${formatCountMap(summary.countsByTier)}`,
    `Counts by skill: ${formatCountMap(summary.countsBySkill)}`,
    `Total duration: ${formatNullableMs(summary.totalDurationMs)}`,
    `Turns: ${formatNullableNumber(summary.turns)}`,
    `First response latency: ${formatNullableMs(summary.firstResponseLatencyMs)}`,
    `Flaky: ${formatFlaky(summary.flaky)}`,
    "",
    ...failureLines,
    "",
    "Entries:",
    ...entryLines,
  ].join("\n");
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
