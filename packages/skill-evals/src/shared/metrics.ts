import { eventType, findStringValue, isRecord, isStringArray } from "./events.js";
import type { BaseEvalMetrics, CommandSummary, FixtureValidation } from "./types.js";

const TEXT_KEYS = ["content", "message", "output_text", "text"];

export type ObservedSkillRead = {
  displayName: string;
  observed: boolean;
  skillPath: string;
};

export type BaseMetricOptions = {
  observedSkillPaths?: readonly string[];
  runnerExitCode: number | null;
};

function isModelPhase(event: Record<string, unknown>): boolean {
  return event.phase === "model";
}

function containsSkillFileRead(event: unknown, skillPath: string): boolean {
  if (!isRecord(event)) return false;
  if (eventType(event) !== "codex_event") return false;

  const nestedEvent = event.event;
  if (!findStringValue(nestedEvent, (value) => value.includes(skillPath))) {
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

export function collectModelOutputText(event: unknown): string[] {
  if (!isRecord(event)) return [];
  if (eventType(event) !== "codex_event") return [];
  return collectAssistantText(event.event);
}

export function deriveBaseMetrics(
  events: readonly unknown[],
  fixtureValidation: FixtureValidation,
  options: BaseMetricOptions,
): BaseEvalMetrics & { modelOutputText: string; observedSkillReads: readonly ObservedSkillRead[] } {
  let firstTreeCalls = 0;
  const firstTreeArgv: string[][] = [];
  const firstTreeCommandResults: CommandSummary[] = [];
  const modelOutputTexts: string[] = [];
  const observedSkillPaths = options.observedSkillPaths ?? [];
  const observedSkillReads = observedSkillPaths.map((skillPath) => ({
    displayName: skillPath,
    observed: false,
    skillPath,
  }));

  for (const event of events) {
    for (const observedSkillRead of observedSkillReads) {
      if (!observedSkillRead.observed && containsSkillFileRead(event, observedSkillRead.skillPath)) {
        observedSkillRead.observed = true;
      }
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
      }

      if (type === "first_tree_result" && typeof event.exitCode === "number") {
        const summary: CommandSummary = {
          argv: [...argv],
          exitCode: event.exitCode,
        };
        if (typeof event.stderrPreview === "string") summary.stderrPreview = event.stderrPreview;
        if (typeof event.stdoutPreview === "string") summary.stdoutPreview = event.stdoutPreview;
        firstTreeCommandResults.push(summary);
      }
    }
  }

  return {
    firstTreeArgv,
    firstTreeCalls,
    firstTreeCommandResults,
    fixtureValidationOk: fixtureValidation.ok,
    modelFirstTreeCommandsOk: firstTreeCommandResults.every((result) => result.exitCode === 0),
    modelOutputText: modelOutputTexts.join("\n"),
    observedSkillReads,
    runnerExitCode: options.runnerExitCode,
  };
}
