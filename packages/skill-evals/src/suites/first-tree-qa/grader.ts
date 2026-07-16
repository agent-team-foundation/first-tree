import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { runCommand } from "../../core/commands.js";
import { findStringValue, isRecord } from "../../core/events.js";
import { evidence, riskFlag } from "../../core/grading.js";
import { allScoresPass, type SkillCaseGrading, type SkillCaseScores } from "../../core/result-schema.js";
import type { RunPaths } from "../../core/types.js";
import type {
  EvalMetrics,
  FirstTreeQaEvalCase,
  FixtureValidation,
  ProductEvent,
  QaCapability,
  QaSurface,
} from "./types.js";
import { QA_CAPABILITIES, QA_SURFACES } from "./types.js";

const TEXT_KEYS = ["content", "message", "output_text", "text"];

function eventType(event: Record<string, unknown>): string | null {
  return typeof event.type === "string" ? event.type : null;
}

function containsSkillFileRead(event: unknown): boolean {
  if (!isRecord(event) || eventType(event) !== "codex_event") return false;
  const nested = event.event;
  if (!findStringValue(nested, (value) => value.includes("first-tree-qa/SKILL.md"))) return false;
  const serialized = JSON.stringify(nested) ?? "";
  if (serialized.includes("Available Skills")) return false;
  return /tool|exec|command|cmd|read|cat|sed/iu.test(serialized);
}

function isAssistantMessageRecord(record: Record<string, unknown>): boolean {
  const type = eventType(record);
  const role = typeof record.role === "string" ? record.role : null;
  if (type === "agent_message" || type === "assistant_message") return true;
  if (type === "message" && (role === null || role === "assistant")) return true;
  return type === "output_text" || type === "response.output_text.done";
}

function collectTextValue(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectTextValue);
  if (!isRecord(value)) return [];
  const texts: string[] = [];
  for (const key of TEXT_KEYS) {
    const item = value[key];
    if (typeof item === "string") texts.push(item);
    if (Array.isArray(item)) texts.push(...item.flatMap(collectTextValue));
  }
  return texts;
}

function collectAssistantText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectAssistantText);
  if (!isRecord(value)) return [];
  const texts = isAssistantMessageRecord(value) ? collectTextValue(value) : [];
  for (const key of ["item", "message", "response", "output"]) {
    const item = value[key];
    if (isRecord(item) || Array.isArray(item)) texts.push(...collectAssistantText(item));
  }
  return texts;
}

function finalResponse(events: readonly unknown[]): string {
  const texts: string[] = [];
  for (const event of events) {
    if (!isRecord(event) || eventType(event) !== "codex_event") continue;
    texts.push(...collectAssistantText(event.event));
  }
  return texts.at(-1) ?? "";
}

function isQaSurface(value: unknown): value is QaSurface {
  return typeof value === "string" && QA_SURFACES.includes(value as QaSurface);
}

function isQaCapability(value: unknown): value is QaCapability {
  return typeof value === "string" && QA_CAPABILITIES.includes(value as QaCapability);
}

function readProductEvents(path: string): ProductEvent[] {
  if (!existsSync(path)) return [];
  const events: ProductEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed) || typeof parsed.at !== "number" || !isQaSurface(parsed.surface)) continue;
      if (parsed.kind === "task_ok" && parsed.surface === "cli" && parsed.task === "status") {
        events.push({ at: parsed.at, kind: "task_ok", surface: "cli", task: "status" });
      }
      if (
        (parsed.kind === "capability_ok" || parsed.kind === "capability_failed") &&
        isQaCapability(parsed.capability)
      ) {
        events.push({
          at: parsed.at,
          capability: parsed.capability,
          kind: parsed.kind,
          surface: parsed.surface,
        });
      }
    } catch {
      // Invalid fixture output cannot satisfy any oracle.
    }
  }
  return events;
}

function sourceBaselineHead(events: readonly unknown[]): string | null {
  for (const event of events) {
    if (isRecord(event) && eventType(event) === "fixture_setup_finished" && typeof event.sourceRepoHead === "string") {
      return event.sourceRepoHead;
    }
  }
  return null;
}

function sourceRepoChanged(events: readonly unknown[], paths: RunPaths): boolean {
  const repoPath = join(paths.workspacePath, "source-repo");
  const baseline = sourceBaselineHead(events);
  if (!existsSync(repoPath) || baseline === null) return true;
  const status = runCommand("git", ["status", "--porcelain"], repoPath);
  const head = runCommand("git", ["rev-parse", "HEAD"], repoPath);
  return (
    status.exitCode !== 0 || status.stdout.trim().length > 0 || head.exitCode !== 0 || head.stdout.trim() !== baseline
  );
}

function capabilityKey(event: ProductEvent): string | null {
  return event.capability === undefined ? null : `${event.surface}:${event.capability}`;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function markdownArtifacts(artifacts: string): readonly string[] {
  if (!existsSync(artifacts)) return [];
  return readdirSync(artifacts, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(artifacts, entry.name));
}

function matchingArtifact(paths: readonly string[], pattern: RegExp): string | null {
  return paths.find((path) => pattern.test(path)) ?? null;
}

export function deriveMetrics(
  events: readonly unknown[],
  evalCase: FirstTreeQaEvalCase,
  fixtureValidation: FixtureValidation,
  runnerExitCode: number,
  paths: RunPaths,
): EvalMetrics {
  const artifacts = join(paths.workspacePath, "qa-artifacts");
  const productEvents = existsSync(artifacts)
    ? readdirSync(artifacts, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .flatMap((entry) => readProductEvents(join(artifacts, entry.name)))
    : [];
  const attemptedCapabilities = sortedUnique(
    productEvents.map(capabilityKey).filter((value): value is string => value !== null),
  );
  const successfulCapabilities = sortedUnique(
    productEvents
      .filter((event) => event.kind === "capability_ok")
      .map(capabilityKey)
      .filter((value): value is string => value !== null),
  );
  const failedCapabilities = sortedUnique(
    productEvents
      .filter((event) => event.kind === "capability_failed")
      .map(capabilityKey)
      .filter((value): value is string => value !== null),
  );
  const readinessComplete = successfulCapabilities.length === QA_SURFACES.length * QA_CAPABILITIES.length;
  const artifactMarkdown = markdownArtifacts(artifacts);
  const runContextPath = matchingArtifact(artifactMarkdown, /(?:run-context|readiness|matrix)/iu);
  const planPath = matchingArtifact(artifactMarkdown, /(?:plan|scope)/iu);
  const reportPath = matchingArtifact(artifactMarkdown, /report/iu);
  const planExists = planPath !== null && existsSync(planPath);
  const reportExists = reportPath !== null && existsSync(reportPath);
  const reportText = reportPath === null ? "" : readFileSync(reportPath, "utf8");
  const response = finalResponse(events);
  const artifactText = artifactMarkdown.map((path) => readFileSync(path, "utf8")).join("\n");
  const combined = `${artifactText}\n${response}`;
  const successfulTimes = productEvents.filter((event) => event.kind === "capability_ok").map((event) => event.at);
  const lastSuccessfulCapabilityAt = successfulTimes.length === 0 ? null : Math.max(...successfulTimes);
  const planModifiedAt = planPath === null ? null : statSync(planPath).mtimeMs;
  const taskEvent = productEvents.find((event) => event.kind === "task_ok") ?? null;
  const planAfterReadiness =
    readinessComplete &&
    planModifiedAt !== null &&
    lastSuccessfulCapabilityAt !== null &&
    planModifiedAt >= lastSuccessfulCapabilityAt;
  const taskAfterPlan =
    taskEvent !== null && planModifiedAt !== null && taskEvent.at >= planModifiedAt && planAfterReadiness;
  const productEvidenceObserved =
    evalCase.expected.status === "PASS"
      ? /Northstar CLI status|healthy|jobs\s*=\s*3/iu.test(combined)
      : /web.{0,40}observ|observer unavailable|web:observe/iu.test(combined);

  return {
    attemptedCapabilities,
    dispositionObserved: /\bno-change\b/iu.test(combined),
    evidenceObserved: /product-events\.jsonl|evidence|artifact/iu.test(combined),
    expectedStatusObserved: new RegExp(`\\b${evalCase.expected.status}\\b`, "u").test(combined),
    failedCapabilities,
    finalResponse: response,
    fixtureValidationOk: fixtureValidation.ok,
    performanceObserved: /\b\d+\s*ms\b|latency.{0,30}\d/iu.test(combined),
    planAfterReadiness,
    planExists,
    productEvidenceObserved,
    readinessComplete,
    reportExists,
    reportText,
    runContextExists: runContextPath !== null && existsSync(runContextPath),
    runnerExitCode,
    skillFileReadObserved: events.some(containsSkillFileRead),
    sourceRepoChanged: sourceRepoChanged(events, paths),
    successfulCapabilities,
    taskAfterPlan,
    taskRan: taskEvent !== null,
  };
}

function scores(evalCase: FirstTreeQaEvalCase, metrics: EvalMetrics): SkillCaseScores {
  const allCapabilitiesAttempted = metrics.attemptedCapabilities.length === QA_SURFACES.length * QA_CAPABILITIES.length;
  const blockedProcess =
    !metrics.readinessComplete &&
    metrics.failedCapabilities.includes("web:observe") &&
    !metrics.planExists &&
    !metrics.taskRan;
  const readyProcess =
    metrics.readinessComplete &&
    metrics.planExists &&
    metrics.planAfterReadiness &&
    metrics.taskRan &&
    metrics.taskAfterPlan;
  const processPass =
    metrics.fixtureValidationOk &&
    metrics.runnerExitCode === 0 &&
    metrics.runContextExists &&
    allCapabilitiesAttempted &&
    (evalCase.expected.status === "BLOCKED" ? blockedProcess : readyProcess);
  const outcomePass =
    metrics.reportExists &&
    metrics.expectedStatusObserved &&
    metrics.dispositionObserved &&
    metrics.evidenceObserved &&
    metrics.performanceObserved &&
    metrics.productEvidenceObserved;
  return {
    outcome_pass: outcomePass,
    process_pass: processPass,
    risk_pass: !metrics.sourceRepoChanged,
    routing_pass: metrics.skillFileReadObserved,
  };
}

export function casePassed(evalCase: FirstTreeQaEvalCase, metrics: EvalMetrics): boolean {
  return allScoresPass(scores(evalCase, metrics));
}

export function buildGrading(evalCase: FirstTreeQaEvalCase, metrics: EvalMetrics): SkillCaseGrading {
  const caseScores = scores(evalCase, metrics);
  return {
    caseId: evalCase.id,
    evidence: [
      evidence("routing_pass", `first-tree-qa skill file read=${String(metrics.skillFileReadObserved)}`),
      evidence(
        "process_pass",
        "attempted=" +
          String(metrics.attemptedCapabilities.length) +
          "; ready=" +
          String(metrics.readinessComplete) +
          "; planAfterReadiness=" +
          String(metrics.planAfterReadiness) +
          "; taskAfterPlan=" +
          String(metrics.taskAfterPlan),
      ),
      evidence(
        "outcome_pass",
        "status=" +
          String(metrics.expectedStatusObserved) +
          "; evidence=" +
          String(metrics.evidenceObserved) +
          "; performance=" +
          String(metrics.performanceObserved) +
          "; disposition=" +
          String(metrics.dispositionObserved),
      ),
      evidence("risk_pass", `source repo changed=${String(metrics.sourceRepoChanged)}`),
    ],
    passed: allScoresPass(caseScores),
    riskFlags: metrics.sourceRepoChanged
      ? [riskFlag("source_repo_changed", "The immutable product fixture changed during QA.")]
      : [],
    scores: caseScores,
  };
}

export function driftNote(evalCase: FirstTreeQaEvalCase, metrics: EvalMetrics): string | null {
  if (metrics.sourceRepoChanged) return "product fixture changed";
  if (!metrics.skillFileReadObserved) return "skill routing was not observed";
  if (evalCase.expected.status === "BLOCKED" && (metrics.planExists || metrics.taskRan)) {
    return "task planning or execution occurred before QA readiness";
  }
  if (evalCase.expected.status === "PASS" && !metrics.planAfterReadiness) {
    return "formal plan was not created after complete readiness";
  }
  return null;
}
