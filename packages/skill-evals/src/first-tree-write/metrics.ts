import { isTreeTreeArgv, isTreeTreeHelpArgv } from "../shared/commands.js";
import { normalizeForMatch } from "../shared/events.js";
import { deriveBaseMetrics } from "../shared/metrics.js";
import type { EvalMetrics, FixtureValidation } from "./types.js";

const WRITE_SKILL_PATH = "first-tree-write/SKILL.md";
const READ_SKILL_PATH = "first-tree-read/SKILL.md";

const WRITE_INTENT_PATTERNS = [
  /\bwrite\b/iu,
  /\bupdate\b/iu,
  /\bcapture\b/iu,
  /\brecord\b/iu,
  /\breflect\b/iu,
  /\bedit\b/iu,
  /\bcreate (?:a )?(?:new )?(?:leaf|node)\b/iu,
  /\btarget(?: path| node)?\b/iu,
  /\bplanned write\b/iu,
];

function targetNeedle(expectedTargetPath: string): string {
  return normalizeForMatch(expectedTargetPath);
}

function textMentionsTarget(text: string, expectedTargetPath: string): boolean {
  return normalizeForMatch(text).includes(targetNeedle(expectedTargetPath));
}

function commandResultMentionsTarget(
  result: { stderrPreview?: string; stdoutPreview?: string },
  expectedTargetPath: string,
): boolean {
  return textMentionsTarget(`${result.stdoutPreview ?? ""}\n${result.stderrPreview ?? ""}`, expectedTargetPath);
}

function hasWriteIntent(text: string): boolean {
  return WRITE_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

function isTreeListingArgv(argv: readonly string[]): boolean {
  return isTreeTreeArgv(argv) && !isTreeTreeHelpArgv(argv);
}

export function deriveMetrics(
  events: readonly unknown[],
  fixtureValidation: FixtureValidation,
  runnerExitCode: number | null,
  expectedTargetPath: string,
): EvalMetrics {
  const base = deriveBaseMetrics(events, fixtureValidation, {
    observedSkillPaths: [WRITE_SKILL_PATH, READ_SKILL_PATH],
    runnerExitCode,
  });
  const writeSkillFileReadObserved = base.observedSkillReads.some(
    (read) => read.skillPath === WRITE_SKILL_PATH && read.observed,
  );
  const readSkillFileReadObserved = base.observedSkillReads.some(
    (read) => read.skillPath === READ_SKILL_PATH && read.observed,
  );
  const treeTreeCalls = base.firstTreeArgv.filter(isTreeListingArgv).length;
  const treeTreeSucceeded = base.firstTreeCommandResults.some(
    (result) => isTreeListingArgv(result.argv) && result.exitCode === 0,
  );
  const targetObservedInTreeListing = base.firstTreeCommandResults.some(
    (result) =>
      isTreeListingArgv(result.argv) &&
      result.exitCode === 0 &&
      commandResultMentionsTarget(result, expectedTargetPath),
  );
  const targetMentionedInOutput = textMentionsTarget(base.modelOutputText, expectedTargetPath);
  const targetObservedAfterTreeListing = treeTreeSucceeded && targetMentionedInOutput;
  const targetPathObserved = targetObservedInTreeListing || targetObservedAfterTreeListing;
  const commandFailuresDuringModel = base.firstTreeCommandResults
    .filter((result) => result.exitCode !== 0)
    .map((result) => ({ argv: result.argv, exitCode: result.exitCode }));
  const writeIntentInOutput = hasWriteIntent(base.modelOutputText);
  const writeSkillHit = writeSkillFileReadObserved || writeIntentInOutput;
  const readSkillHit = readSkillFileReadObserved;

  return {
    accidentalWriteHit: false,
    commandFailuresDuringModel,
    firstTreeArgv: base.firstTreeArgv,
    firstTreeCalls: base.firstTreeCalls,
    firstTreeCommandResults: base.firstTreeCommandResults,
    fixtureValidationOk: base.fixtureValidationOk,
    modelFirstTreeCommandsOk: base.modelFirstTreeCommandsOk,
    readSkillFileReadObserved,
    readSkillHit,
    runnerExitCode: base.runnerExitCode,
    targetMentionedInOutput,
    targetObservedAfterTreeListing,
    targetObservedInTreeListing,
    targetPathObserved,
    treeTreeCalls,
    treeTreeSucceeded,
    writeIntentInOutput,
    writeSkillFileReadObserved,
    writeSkillHit,
  };
}

export function casePassed(
  expectedTrigger: boolean,
  metrics: EvalMetrics,
  options: { allowReadSkillTreeLookupOnNonTrigger: boolean },
): boolean {
  if (!metrics.fixtureValidationOk) return false;
  if (metrics.runnerExitCode !== 0) return false;

  if (expectedTrigger) {
    return (
      metrics.writeSkillFileReadObserved &&
      metrics.treeTreeSucceeded &&
      metrics.targetPathObserved &&
      metrics.modelFirstTreeCommandsOk
    );
  }

  return (
    !metrics.writeSkillFileReadObserved &&
    !metrics.writeIntentInOutput &&
    (options.allowReadSkillTreeLookupOnNonTrigger ? true : metrics.treeTreeCalls === 0) &&
    metrics.modelFirstTreeCommandsOk
  );
}

export function withAccidentalWriteHit(metrics: EvalMetrics, expectedTrigger: boolean): EvalMetrics {
  return {
    ...metrics,
    accidentalWriteHit: !expectedTrigger && (metrics.writeSkillFileReadObserved || metrics.writeIntentInOutput),
  };
}

export function fixtureOnlyPassed(fixtureValidation: FixtureValidation): boolean {
  return fixtureValidation.ok;
}
