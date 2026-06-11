import { findStringValue, isRecord, isStringArray } from "./events.js";
import type { EvalMetrics, FixtureValidation } from "./types.js";

const HELP_ARGV = ["tree", "tree", "--help"];
const TEXT_KEYS = ["content", "message", "output_text", "text"];

function argvEquals(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isHelpArgv(argv: readonly string[]): boolean {
  return argvEquals(argv, HELP_ARGV);
}

function isTreeTreeArgv(argv: readonly string[]): boolean {
  return argv[0] === "tree" && argv[1] === "tree";
}

function isTreeSelectorArgv(argv: readonly string[]): boolean {
  return isTreeTreeArgv(argv) && !isHelpArgv(argv);
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

function isAssistantMessageRecord(record: Record<string, unknown>): boolean {
  const type = eventType(record);
  const role = typeof record.role === "string" ? record.role : null;

  if (type === "agent_message" || type === "assistant_message") return true;
  if (type === "message" && (role === null || role === "assistant")) return true;
  if (type === "output_text" || type === "response.output_text.done") return true;

  return false;
}

function collectTextValue(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    const texts: string[] = [];
    for (const item of value) {
      texts.push(...collectTextValue(item));
    }
    return texts;
  }
  if (!isRecord(value)) return [];

  const texts: string[] = [];
  for (const key of TEXT_KEYS) {
    const item = value[key];
    if (typeof item === "string") {
      texts.push(item);
    } else if (Array.isArray(item)) {
      texts.push(...collectTextValue(item));
    }
  }
  return texts;
}

function collectAssistantText(value: unknown): string[] {
  if (Array.isArray(value)) {
    const texts: string[] = [];
    for (const item of value) {
      texts.push(...collectAssistantText(item));
    }
    return texts;
  }
  if (!isRecord(value)) return [];

  const texts: string[] = [];
  if (isAssistantMessageRecord(value)) {
    texts.push(...collectTextValue(value));
  }

  const item = value.item;
  if (isRecord(item)) {
    texts.push(...collectAssistantText(item));
  }

  const message = value.message;
  if (isRecord(message)) {
    texts.push(...collectAssistantText(message));
  }

  const response = value.response;
  if (isRecord(response) || Array.isArray(response)) {
    texts.push(...collectAssistantText(response));
  }

  const output = value.output;
  if (Array.isArray(output)) {
    texts.push(...collectAssistantText(output));
  }

  return texts;
}

function collectModelOutputText(event: unknown): string[] {
  if (!isRecord(event)) return [];
  if (eventType(event) !== "codex_event") return [];
  return collectAssistantText(event.event);
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function uniqueStrings(values: readonly string[]): string[] {
  const unique: string[] = [];
  for (const value of values) {
    if (!unique.includes(value)) unique.push(value);
  }
  return unique;
}

function expectedFactHits(modelOutputText: string, expectedFacts: readonly string[]): string[] {
  const normalizedOutput = normalizeForMatch(modelOutputText);
  const hits: string[] = [];

  for (const fact of uniqueStrings(expectedFacts)) {
    const normalizedFact = normalizeForMatch(fact);
    if (normalizedFact.length > 0 && normalizedOutput.includes(normalizedFact)) {
      hits.push(fact);
    }
  }

  return hits;
}

export function deriveMetrics(
  events: readonly unknown[],
  fixtureValidation: FixtureValidation,
  runnerExitCode: number | null,
  expectedFacts: readonly string[],
): EvalMetrics {
  let firstTreeCalls = 0;
  let helpCalls = 0;
  let skillFileReadObserved = false;
  const firstTreeArgv: string[][] = [];
  const firstTreeCommandResults: Array<{ argv: string[]; exitCode: number }> = [];
  const helpExitCodes: number[] = [];
  const modelOutputTexts: string[] = [];

  for (const event of events) {
    if (containsSkillFileRead(event)) {
      skillFileReadObserved = true;
    }

    modelOutputTexts.push(...collectModelOutputText(event));

    if (!isRecord(event)) continue;
    const type = eventType(event);
    if ((type === "first_tree_call" || type === "first_tree_result") && isModelPhase(event)) {
      const argv = event.argv;
      if (!isStringArray(argv)) continue;

      if (type === "first_tree_call") {
        firstTreeCalls += 1;
        firstTreeArgv.push([...argv]);
        if (isHelpArgv(argv)) {
          helpCalls += 1;
        }
      }

      if (type === "first_tree_result" && typeof event.exitCode === "number") {
        firstTreeCommandResults.push({ argv: [...argv], exitCode: event.exitCode });
        if (isHelpArgv(argv)) {
          helpExitCodes.push(event.exitCode);
        }
      }
    }
  }

  const facts = uniqueStrings(expectedFacts);
  const factHits = expectedFactHits(modelOutputTexts.join("\n"), facts);
  const helpSucceeded = firstTreeCommandResults.some((result) => isHelpArgv(result.argv) && result.exitCode === 0);
  const selectionSucceeded = firstTreeCommandResults.some(
    (result) => isTreeSelectorArgv(result.argv) && result.exitCode === 0,
  );
  const modelFirstTreeCommandsOk = firstTreeCommandResults.every((result) => result.exitCode === 0);

  return {
    expectedFactHits: factHits,
    expectedFactsObserved: facts.length > 0 && factHits.length === facts.length,
    firstTreeArgv,
    firstTreeCalls,
    firstTreeCommandResults,
    fixtureValidationOk: fixtureValidation.ok,
    helpAttempted: helpCalls > 0,
    helpCalls,
    helpExitCodes,
    helpSucceeded,
    modelFirstTreeCommandsOk,
    runnerExitCode,
    selectionSucceeded,
    skillFileReadObserved,
    skillHit: skillFileReadObserved || firstTreeCalls > 0 || firstTreeCommandResults.length > 0,
  };
}

export function casePassed(expectedTrigger: boolean, metrics: EvalMetrics): boolean {
  if (!metrics.fixtureValidationOk) return false;
  if (metrics.runnerExitCode !== 0) return false;

  if (expectedTrigger) {
    return (
      metrics.skillFileReadObserved &&
      metrics.expectedFactsObserved &&
      metrics.helpSucceeded &&
      metrics.selectionSucceeded &&
      metrics.modelFirstTreeCommandsOk
    );
  }

  return (
    !metrics.skillHit &&
    metrics.expectedFactHits.length === 0 &&
    metrics.firstTreeCalls === 0 &&
    metrics.firstTreeCommandResults.length === 0 &&
    metrics.modelFirstTreeCommandsOk
  );
}

export function fixtureOnlyPassed(fixtureValidation: FixtureValidation): boolean {
  return fixtureValidation.ok;
}
