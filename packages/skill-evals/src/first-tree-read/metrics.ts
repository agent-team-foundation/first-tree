import { findStringValue, isRecord, isStringArray } from "./events.js";
import type { EvalMetrics, FixtureValidation } from "./types.js";

const HELP_ARGV = ["tree", "tree", "--help"];

function argvEquals(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isModelPhase(event: Record<string, unknown>): boolean {
  return event.phase === "model";
}

function eventType(event: Record<string, unknown>): string | null {
  return typeof event.type === "string" ? event.type : null;
}

function containsSkillFileRead(event: unknown): boolean {
  if (!isRecord(event)) return false;
  if (eventType(event) !== "codex_event") return false;

  const nestedEvent = event.event;
  if (!findStringValue(nestedEvent, (value) => value.includes("first-tree-read/SKILL.md"))) {
    return false;
  }

  const serialized = JSON.stringify(nestedEvent) ?? "";
  if (serialized.includes("Available Skills")) return false;
  return /tool|exec|command|cmd|read|cat|sed/iu.test(serialized);
}

export function deriveMetrics(
  events: readonly unknown[],
  fixtureValidation: FixtureValidation,
  runnerExitCode: number | null,
): EvalMetrics {
  let firstTreeDevCalls = 0;
  let helpCalls = 0;
  let skillFileReadObserved = false;
  let treeTreeCommandObserved = false;
  const firstTreeDevArgv: string[][] = [];
  const helpExitCodes: number[] = [];

  for (const event of events) {
    if (containsSkillFileRead(event)) {
      skillFileReadObserved = true;
    }

    if (!isRecord(event)) continue;
    const type = eventType(event);
    if ((type === "first_tree_dev_call" || type === "first_tree_dev_result") && isModelPhase(event)) {
      const argv = event.argv;
      if (!isStringArray(argv)) continue;

      if (type === "first_tree_dev_call") {
        firstTreeDevCalls += 1;
        firstTreeDevArgv.push(argv);
        if (argv[0] === "tree" && argv[1] === "tree") {
          treeTreeCommandObserved = true;
        }
        if (argvEquals(argv, HELP_ARGV)) {
          helpCalls += 1;
        }
      }

      if (type === "first_tree_dev_result" && argvEquals(argv, HELP_ARGV) && typeof event.exitCode === "number") {
        helpExitCodes.push(event.exitCode);
      }
    }
  }

  return {
    firstTreeDevArgv,
    firstTreeDevCalls,
    fixtureValidationOk: fixtureValidation.ok,
    helpAttempted: helpCalls > 0,
    helpCalls,
    helpExitCodes,
    runnerExitCode,
    skillFileReadObserved,
    skillHit: helpCalls > 0 || treeTreeCommandObserved || skillFileReadObserved,
  };
}

export function casePassed(expectedTrigger: boolean, metrics: EvalMetrics): boolean {
  if (!metrics.fixtureValidationOk) return false;
  if (metrics.runnerExitCode !== 0) return false;

  if (expectedTrigger) {
    return metrics.skillHit && metrics.helpCalls >= 1 && metrics.firstTreeDevCalls >= 1;
  }

  return !metrics.skillHit && metrics.helpCalls === 0 && metrics.firstTreeDevCalls === 0;
}

export function fixtureOnlyPassed(fixtureValidation: FixtureValidation): boolean {
  return fixtureValidation.ok;
}
