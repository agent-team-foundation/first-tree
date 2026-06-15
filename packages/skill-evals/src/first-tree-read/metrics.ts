import { isTreeTreeHelpArgv, isTreeTreeSelectorArgv } from "../shared/commands.js";
import { normalizeForMatch, uniqueStrings } from "../shared/events.js";
import { deriveBaseMetrics } from "../shared/metrics.js";
import type { EvalMetrics, FixtureValidation } from "./types.js";

const READ_SKILL_PATH = "first-tree-read/SKILL.md";

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
  const base = deriveBaseMetrics(events, fixtureValidation, {
    observedSkillPaths: [READ_SKILL_PATH],
    runnerExitCode,
  });
  const facts = uniqueStrings(expectedFacts);
  const factHits = expectedFactHits(base.modelOutputText, facts);
  const helpExitCodes = base.firstTreeCommandResults
    .filter((result) => isTreeTreeHelpArgv(result.argv))
    .map((result) => result.exitCode);
  const helpCalls = base.firstTreeArgv.filter(isTreeTreeHelpArgv).length;
  const helpSucceeded = base.firstTreeCommandResults.some(
    (result) => isTreeTreeHelpArgv(result.argv) && result.exitCode === 0,
  );
  const selectionSucceeded = base.firstTreeCommandResults.some(
    (result) => isTreeTreeSelectorArgv(result.argv) && result.exitCode === 0,
  );
  const skillFileReadObserved = base.observedSkillReads.some(
    (read) => read.skillPath === READ_SKILL_PATH && read.observed,
  );

  return {
    expectedFactHits: factHits,
    expectedFactsObserved: facts.length > 0 && factHits.length === facts.length,
    firstTreeArgv: base.firstTreeArgv,
    firstTreeCalls: base.firstTreeCalls,
    firstTreeCommandResults: base.firstTreeCommandResults,
    fixtureValidationOk: base.fixtureValidationOk,
    helpAttempted: helpCalls > 0,
    helpCalls,
    helpExitCodes,
    helpSucceeded,
    modelFirstTreeCommandsOk: base.modelFirstTreeCommandsOk,
    runnerExitCode: base.runnerExitCode,
    selectionSucceeded,
    skillFileReadObserved,
    skillHit: skillFileReadObserved || base.firstTreeCalls > 0 || base.firstTreeCommandResults.length > 0,
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
